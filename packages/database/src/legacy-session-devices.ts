import { sql } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";

type DatabaseExecutor = Pick<DatabaseConnection["db"], "execute">;

export interface LegacySessionDeviceScope {
  organizationId: string;
  userId: string;
}

export async function backfillTrustedLegacySessionDevices(
  database: DatabaseExecutor,
  scope?: LegacySessionDeviceScope,
): Promise<void> {
  const deviceColumn = await database.execute(sql`
    select 1
    from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'time_sessions'
      and column_name = 'device_id'
    limit 1
  `);
  if (deviceColumn.length === 0) return;
  const scopedSessions = scope === undefined
    ? sql``
    : sql`
      and session.organization_id = ${scope.organizationId}
      and session.user_id = ${scope.userId}
    `;

  await database.execute(sql`
    with candidate_devices as (
      select
        session.id as session_id,
        min(segment.device_id::text)::uuid as device_id,
        session.idle_seconds
      from time_sessions session
      inner join activity_segments segment
        on segment.organization_id = session.organization_id
        and segment.user_id = session.user_id
        and segment.started_at < session.stopped_at
        and segment.ended_at > session.started_at
      where session.device_id is null
        and session.status in ('stopped', 'needs_review')
        and session.stopped_at is not null
        ${scopedSessions}
      group by session.id, session.idle_seconds
      having count(distinct segment.device_id) = 1
    ),
    inactive_segments as (
      select
        candidate.session_id,
        greatest(segment.started_at, session.started_at) as started_at,
        least(segment.ended_at, session.stopped_at) as ended_at
      from candidate_devices candidate
      inner join time_sessions session on session.id = candidate.session_id
      inner join activity_segments segment
        on segment.organization_id = session.organization_id
        and segment.user_id = session.user_id
        and segment.device_id = candidate.device_id
        and segment.kind <> 'active'
        and segment.started_at < session.stopped_at
        and segment.ended_at > session.started_at
    ),
    ordered_segments as (
      select
        session_id,
        started_at,
        ended_at,
        max(ended_at) over (
          partition by session_id
          order by started_at, ended_at
          rows between unbounded preceding and 1 preceding
        ) as previous_end
      from inactive_segments
    ),
    grouped_segments as (
      select
        session_id,
        started_at,
        ended_at,
        sum(case when previous_end is null or started_at > previous_end then 1 else 0 end)
          over (
            partition by session_id
            order by started_at, ended_at
            rows unbounded preceding
          ) as interval_group
      from ordered_segments
    ),
    merged_segments as (
      select
        session_id,
        min(started_at) as started_at,
        max(ended_at) as ended_at
      from grouped_segments
      group by session_id, interval_group
    ),
    trusted_sessions as (
      select candidate.session_id, candidate.device_id
      from candidate_devices candidate
      left join merged_segments merged on merged.session_id = candidate.session_id
      group by candidate.session_id, candidate.device_id, candidate.idle_seconds
      having floor(coalesce(sum(extract(epoch from (merged.ended_at - merged.started_at))), 0))::integer = candidate.idle_seconds
    )
    update time_sessions session
    set device_id = trusted.device_id
    from trusted_sessions trusted
    where session.id = trusted.session_id
      and session.device_id is null
  `);
}

-- 0013 serialise owner changes per organisation.
--
-- guard_last_owner() (0011) checks "is there another owner?" and then lets the change through. Two transactions can do that at the same
-- time: owner A removes owner B while B removes A. Each sees the other still present, both commit, and the organisation is left with
-- members but no owner. Under READ COMMITTED the check alone cannot prevent that.
--
-- Fix: before checking, take a lock on the organisation row (FOR NO KEY UPDATE). It conflicts with itself, so two owner removals or
-- demotions in one organisation run one after the other, and the second one's check (a fresh statement, so it sees the first one's
-- committed change) finds the true state. FOR NO KEY UPDATE does not conflict with the FOR KEY SHARE that foreign keys take, so
-- creating projects or memberships in the organisation is not blocked. If the organisation row is gone (the organisation itself is being
-- removed) the guard has nothing to protect and steps aside, as before. People can still leave whenever another owner remains, or when
-- they are the only member.
-- Additive: replaces the function body only; never edit 0011.

create or replace function public.guard_last_owner()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare org_id uuid;
begin
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
    select o.id into org_id from public.organisations o where o.id = old.organisation_id for no key update;
    if org_id is not null
       and exists (select 1 from public.organisation_members m where m.organisation_id = old.organisation_id and m.user_id <> old.user_id)
       and not exists (select 1 from public.organisation_members m where m.organisation_id = old.organisation_id and m.user_id <> old.user_id and m.role = 'owner')
    then
      raise exception 'An organisation must keep at least one owner' using errcode = 'check_violation';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.guard_last_owner() from public;

// Records an event in the tamper-evident audit trail (migration 0014). Best effort: a failure to record is logged, never allowed to
// break the user's request. Row changes (members, projects, Search Console tokens) are recorded by database triggers instead, so
// they cannot be forgotten here. Never pass secrets: audit_record() also strips keys that look like secrets.
async function recordAudit(db, { org = null, actor = null, action, targetType = null, targetId = null, detail = {} }, log = console.error) {
  try {
    const { error } = await db.rpc('audit_record', { p_org: org, p_actor: actor, p_action: action, p_target_type: targetType, p_target_id: targetId == null ? null : String(targetId), p_detail: detail });
    if (error && !(error.code === 'PGRST202' || error.code === '42883')) log('audit record failed:', String(error.code || 'error'));
  } catch (e) { log('audit record failed:', String((e && e.name) || 'error')); }
}
module.exports = { recordAudit };

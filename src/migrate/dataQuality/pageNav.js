// Shared header for the data check result pages (repair groups and record details) so both pages show where the user is.
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const navStyles = `
.topnav{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin:0 0 20px;padding-bottom:12px;border-bottom:1px solid #d0d7de}
.topnav .back{font-size:13px;text-decoration:none;color:#57606a}
.topnav .back:hover{color:#0969da}
.tabs{display:flex;gap:4px;padding:3px;background:#eaeef2;border-radius:8px}
.tabs a{padding:5px 14px;font-size:13px;font-weight:500;text-decoration:none;color:#57606a;border-radius:6px}
.tabs a:hover{color:#24292f}
.tabs a.active{color:#24292f;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 8px;font-size:12px;color:#57606a}
.crumbs a{color:#0969da;text-decoration:none}
.crumbs a:hover{text-decoration:underline}
.crumbs .sep{color:#8c959f}
.crumbs [aria-current]{font-weight:600;color:#24292f}
`;

// crumbs: [{ label, href? }]; the last entry is the current page and is not linked.
function renderPageNav({ reportId, active, crumbs = [], backHref = `/wizard?step=3&audit=${encodeURIComponent(reportId)}` }) {
	const base = '/api/quality-audits/' + encodeURIComponent(reportId);
	const tab = (key, href, label) => `<a href="${href}"${active === key ? ' class="active" aria-current="page"' : ''}>${label}</a>`;
	const trail = crumbs.map((crumb, i) => i < crumbs.length - 1 && crumb.href ? `<a href="${crumb.href}">${escape(crumb.label)}</a>` : `<span aria-current="page">${escape(crumb.label)}</span>`).join('<span class="sep" aria-hidden="true">›</span>');
	return `<header class="topnav"><a class="back" href="${backHref}">← Back to migration plan</a><nav class="tabs" aria-label="Data check results">${tab('groups', `${base}/groups`, 'Repair groups')}${tab('records', `${base}/view`, 'Record details')}</nav></header>${crumbs.length > 1 ? `<nav class="crumbs" aria-label="Breadcrumb">${trail}</nav>` : ''}`;
}

module.exports = { navStyles, renderPageNav };

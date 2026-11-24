import { LegalPage, CONTACT } from '../legal';

export const metadata = { title: 'Privacy Policy · Competitor Radar' };

export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy">
      <p>Competitor Radar helps a business see how its website compares with its competitors online. It is run by Pranay Sheth. This page explains what we collect, why, who processes it, and how you can remove it. Questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.</p>

      <h2>What we collect</h2>
      <ul>
        <li><b>Your email address</b>, used to sign you in with a one-time code or link. We do not use passwords.</li>
        <li><b>Your website address</b> and the details we extract from it: keywords, the places you serve, and a short description of the business. You can edit the keywords and places.</li>
        <li><b>Public information about websites</b>: pages of your site and of competitor sites that anyone can open, plus public Google search results for your keywords. We store scores, page titles, headings and similar facts to build your report.</li>
        <li><b>Your plan and usage</b>: which plan you are on, how many updates you have used, and the date and version of the terms you accepted. Payment card details are never stored by us.</li>
        <li><b>Your choices in the app</b>: competitors you add or remove, and fixes you mark as done.</li>
        <li><b>Google Search Console data, only if you connect it</b> (see below).</li>
      </ul>

      <h2>Google Search Console</h2>
      <p>If you choose <i>Connect Search Console</i>, we ask Google for <b>read-only</b> access to your Search Console data for your own site. We receive your search queries, clicks, impressions, average position and click rate for that site, and the list of sites on the account so we can find yours. We cannot change anything in your Search Console account.</p>
      <ul>
        <li>We use this data only to show it to you in your dashboard and report, and to include it in the improvement brief you download. We do not use it for advertising, we do not sell it, and we do not share it with anyone else.</li>
        <li>Our server may process it automatically to produce those views and the daily snapshot. No person at Competitor Radar reads it, except where you ask us for support or where the law requires.</li>
        <li>The access token Google gives us is stored encrypted. You can click <i>Disconnect</i> at any time: this revokes our access with Google and deletes the stored token and the stored Search Console data. You can also remove access in your Google Account under Security, Third-party access.</li>
      </ul>
      <p>Competitor Radar's use and transfer of information received from Google APIs to any other app will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

      <h2>Who processes your data</h2>
      <p>We use these services to run Competitor Radar. We send each only what it needs.</p>
      <ul>
        <li><b>Supabase</b>: database and sign-in. Data is stored in Mumbai, India.</li>
        <li><b>Vercel</b>: hosting and scheduled jobs.</li>
        <li><b>Anthropic</b>: an AI service that reads the public text of websites to extract keywords and to write advice. We do not send your email address to it.</li>
        <li><b>Serper</b>: a search API that returns public Google results for your keywords. We send keywords and place names, not personal data.</li>
        <li><b>Open PageRank</b> and <b>Keywords Everywhere</b>: data providers that return a link-based authority score for a website and search volumes for keywords. We send them website addresses and keywords, not personal data.</li>
        <li><b>Google</b>: sends the sign-in emails (from our sending account) and, if you connect it, provides Search Console data.</li>
      </ul>
      <p>We do not sell your data and we do not use it for advertising.</p>

      <h2>How long we keep it</h2>
      <p>We keep your data while you have an account so your history and trend charts work. To delete your account and everything linked to it, email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> from the address you signed up with. We delete it within 30 days. Backups may hold copies for a short time after that.</p>

      <h2>Your rights</h2>
      <p>You can ask to see, correct, export or delete your data at any time by emailing us. If you are in a region with data-protection law (for example India's DPDP Act or the EU's GDPR), you also have the rights it gives you, and we will respond within the time it requires.</p>

      <h2>Security</h2>
      <p>Access to each account's data is restricted to that account. Connections use HTTPS, and Google access tokens are encrypted at rest. No system is perfectly secure, so please tell us if you suspect a problem.</p>

      <h2>Industry comparisons</h2>
      <p>Each update stores anonymous, site-level measurements (for example page length or whether a feature is present) of your site and the competitors we read, so we can show how your industry changes over time. These come from public pages. We combine figures across different customers only if you switch on benchmarking, only in groups of at least five organisations, and never in a way that identifies you.</p>

      <h2>Cookies</h2>
      <p>We use only the cookies and local storage needed to keep you signed in. We do not use advertising or tracking cookies.</p>

      <h2>Changes</h2>
      <p>If we change this policy in a way that matters, we will update the date above and, for significant changes, tell you by email.</p>
    </LegalPage>
  );
}

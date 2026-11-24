import { LegalPage, CONTACT } from '../legal';

export const metadata = { title: 'Terms of Service · Competitor Radar' };

export default function Terms() {
  return (
    <LegalPage title="Terms of Service">
      <p>These terms cover your use of Competitor Radar, run by Pranay Sheth ("we"). By ticking the box when you sign in, or by using the service, you agree to them; we keep a record of the date and version you accepted. If you do not agree, please do not use the service. Questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.</p>

      <h2>What the service does</h2>
      <p>You add your website and prove you own it. We read its public pages, find competitors from public search results, score each site, and give you a ranking, daily changes and an improvement report. The service is provided as is, and we may change or stop features.</p>

      <h2>Your responsibilities</h2>
      <ul>
        <li>Add only websites you own or are authorised to manage. We check ownership with a DNS record, a meta tag or a file on the site.</li>
        <li>Do not use the service to attack, overload or scrape sites beyond reading their public pages, to break the law, or to try to access other users' data.</li>
        <li>Keep your sign-in email secure. You are responsible for activity on your account.</li>
      </ul>

      <h2>Scores, advice and results</h2>
      <p>Scores and recommendations are estimates based on public information and automated analysis, including AI. They can be wrong or out of date. They are not a guarantee of search ranking, traffic or sales, and not professional advice. Check suggestions before you apply them, especially before changing a live website.</p>

      <h2>Third-party data and services</h2>
      <p>Competitor information comes from public sources. We are not affiliated with the sites listed as competitors. If you connect Google Search Console, our use of that data is described in the <a href="/privacy">Privacy Policy</a>, and you can disconnect at any time.</p>

      <h2>Free trial, plans and payment</h2>
      <p>New accounts start with a free trial: a limited number of updates (each daily update and each "Crawl now" counts as one) within a limited number of days. The limits are shown in the app. When the trial ends, new crawls stop; your existing data and reports stay available to you.</p>
      <p>Paid plans are billed as agreed with you in writing or shown at checkout, in Indian rupees unless stated, plus any taxes (such as GST) that apply. Access is switched on once payment is received and lasts for the period paid for. Unless the plan or invoice says otherwise, fees are not refundable for a period already started. We will tell you before any price change takes effect. Payments may be handled by a payment provider or by bank transfer; we do not store your card details.</p>

      <h2>Reports for your clients</h2>
      <p>If you are an agency or consultant, you may share reports and exports with your own clients. Do not present our numbers as figures from Google, Ahrefs or any other third party, and do not resell the service itself or give your login to others. Methods and limits are described in our methodology notes in the report; please read them before relying on a number.</p>

      <h2>Your content</h2>
      <p>You keep all rights to your website and to the data you provide. You allow us to process it only to run the service for you, as described in the Privacy Policy.</p>

      <h2>Ending your use</h2>
      <p>You can stop using the service and ask us to delete your account at any time. We may suspend accounts that break these terms or put the service at risk.</p>

      <h2>Liability</h2>
      <p>To the extent the law allows, we are not liable for indirect or consequential loss, lost profit or lost data arising from your use of the service, and our total liability for any claim is limited to the amount you paid us in the previous 12 months (which is nothing while the service is free). Nothing here limits liability that cannot be limited by law.</p>

      <h2>Changes and governing law</h2>
      <p>We may update these terms and will change the date above when we do. Continued use means you accept the update. These terms are governed by the laws of India, and the courts of Vadodara, Gujarat have jurisdiction.</p>
    </LegalPage>
  );
}

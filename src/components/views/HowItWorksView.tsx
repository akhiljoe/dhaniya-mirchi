import { CalendarClock, Link2, ListChecks, MessageSquareText } from 'lucide-react';

// How DhaniyaMirchi works, in four short steps (design §12.8). Reached from
// the footer.
const STEPS = [
  {
    icon: Link2,
    title: 'Connect once',
    body: 'Sign in to your grocery app here with your phone number and the code it texts you. We read your past orders in the background. Everyone in your household connects their own.',
  },
  {
    icon: CalendarClock,
    title: 'We learn your rhythm',
    body: 'From your own orders: how often you buy each thing. Recent months count most, so new habits show up within weeks.',
  },
  {
    icon: ListChecks,
    title: 'Running low',
    body: "When you're likely to need something in the next few days, it's on the list. Past its usual gaps, it drops off.",
  },
  {
    icon: MessageSquareText,
    title: 'Tell us what changes',
    body: "Guests coming, time away, what's used every day. Add it on the Household page and the list gets ready before it matters.",
  },
];

export function HowItWorksView() {
  return (
    <div className="max-w-2xl mx-auto px-5 md:px-8 py-6 pb-4 md:pb-6">
      <div className="mb-6 animate-fade-in-down">
        <h1 className="font-display text-2xl text-ink-900 mb-1">How it works</h1>
        <p className="text-sm text-ink-400">Never run out of the everyday things.</p>
      </div>
      <ol className="space-y-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="card p-4 flex gap-4">
            <div className="w-10 h-10 rounded-xl bg-sage-100 flex items-center justify-center shrink-0">
              <s.icon className="w-5 h-5 text-sage-700" />
            </div>
            <div>
              <p className="text-sm font-semibold text-ink-800">
                {i + 1}. {s.title}
              </p>
              <p className="text-sm text-ink-600 mt-1 leading-relaxed">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="text-xs text-ink-400 mt-4 leading-relaxed">
        From each order we keep the items, quantities, prices and dates. Addresses, phone numbers and card details are dropped as the order is read.
      </p>
    </div>
  );
}

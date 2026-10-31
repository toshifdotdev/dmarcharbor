/**
 * Starter questions, grouped by the task an MSP is in the middle of.
 *
 * Each one is answerable from the documentation as it stands; a unit test
 * runs every one through retrieval so a docs change that orphans a starter
 * fails the suite instead of greeting someone with "I don't know".
 */
export interface StarterGroup {
  task: string;
  questions: string[];
}

export const STARTER_GROUPS: readonly StarterGroup[] = [
  {
    task: 'Setting up a client',
    questions: [
      'How do I prove I manage a domain?',
      'What if the domain already has a DMARC record?',
      'How long until reports arrive?',
    ],
  },
  {
    task: 'Reading reports',
    questions: ['What do the five words on a domain mean?', 'What should I do with senders?'],
  },
  {
    task: 'Moving to enforcement',
    questions: ['How do I know a domain is ready for quarantine or reject?', 'Can my client approve enforcement?'],
  },
  {
    task: 'Plans and billing',
    questions: ['What starts on which plan?', 'How is Fleet priced?', 'Do I get a refund?'],
  },
  {
    task: 'Clients and your brand',
    questions: ['Can my clients see their own data?', 'Can I use my own brand and domain?'],
  },
  {
    task: 'API and your data',
    questions: ['Is there an API, and who can create keys?', 'How do I export or delete my data?'],
  },
];

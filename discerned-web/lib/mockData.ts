// Seed data shown in the Cast feed while the Nostr relay connection is establishing.
// Also used as placeholder follows in the sidebar. Not persisted anywhere.

import type { ClipData } from '@/lib/types';

export const MOCK_CLIPS: ClipData[] = [
  {
    capture: {
      id: '2',
      format: 'selection',
      url: 'https://newyorker.com/magazine/2026/04/22',
      title: 'What the Census Misses',
      timestamp: Date.now() - 5 * 3600_000,
      selectionText: 'The argument is not that the numbers are wrong, but that the categories were chosen by people who would never appear in them.',
    },
    evaluation: { interest: 'Insightful', ethics: 'Exemplary', category: 'Politics' },
    encrypted: '',
  },
  {
    capture: {
      id: '3',
      format: 'selection',
      url: 'https://lrb.co.uk/v48/n08',
      title: 'On Borrowed Time: A Reckoning with the Carbon Ledger',
      timestamp: Date.now() - 24 * 3600_000,
      selectionText: 'It is no longer possible to write about climate without writing about debt — moral, generational, intercontinental. The accountants have arrived.',
    },
    evaluation: { interest: 'Wise', ethics: 'Exemplary', category: 'Science' },
    encrypted: '',
  },
  {
    capture: {
      id: '5',
      format: 'selection',
      url: 'https://arstechnica.com/features/2026/04',
      title: 'The Quiet Crisis in Open-Source Maintenance',
      timestamp: Date.now() - 3 * 24 * 3600_000,
      selectionText: 'A project sustaining one billion devices is currently maintained by two people, one of whom is on parental leave.',
    },
    evaluation: { interest: 'Insightful', ethics: 'Honest', category: 'Tech' },
    encrypted: '',
  },
  {
    capture: {
      id: '6',
      format: 'selection',
      url: 'https://quantamagazine.org/an-unlikely-bridge',
      title: 'An Unlikely Bridge Between Number Theory and Crystals',
      timestamp: Date.now() - 4 * 24 * 3600_000,
      selectionText: 'The proof, when it finally came, was so short it could be written on a postcard. It had taken thirty years to find the postcard.',
    },
    evaluation: { interest: 'Insightful', ethics: 'Neutral', category: 'Science' },
    encrypted: '',
  },
];

export const FOLLOWS = [
  { name: 'Maria Popova', handle: 'mariap', avatar: 'M', count: 142 },
  { name: 'Robin Sloan',  handle: 'robin',  avatar: 'R', count: 87 },
  { name: 'Simon Willison', handle: 'simonw', avatar: 'S', count: 211 },
  { name: 'Tyler Austen', handle: 'tausten', avatar: 'T', count: 56 },
  { name: 'Lin-Manuel A.', handle: 'lina',  avatar: 'L', count: 33 },
];

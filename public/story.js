// The presentation: chapters and steps. Edit the wording here; no other file needs to change.
//
// Each step loads a named extract (pushed from the Sheet's Extracts tab), shows only the
// listed panels, and puts the bullets in the presenter bar. Panel ids:
//   tiles     "Where we are" and the Playbook
//   whatif    What-if simulator (cash to Day 268, final order table)
//   size      What-if simulator, with the final order size check run automatically
//   tele      Telemetry and stockout audit
//   drift     Simulator drift
//   comp      Competitor tracking
//   result    Final result card

export const RESULT = {
  projectedFrom: 200,
  projectedP10: 2661520, projectedP50: 2696034, projectedP90: 2725002,
  note: 'Projected on Day 200 after the final order, from 500 simulated futures at 15.0 jobs a day.',
};

export const CHAPTERS = [
  {
    title: 'Restart and climb',
    steps: [
      {
        title: 'Day 50: what we inherited',
        extract: 'day-50', show: ['tiles', 'tele'],
        bullets: [
          'Machines 2 / 3 / 2 on the $750 contract; Station 1 running at 100%.',
          '68 jobs in the factory and lead times above 4 days.',
          'Kit orders of 7,200 were too small: six stockout waves by Day 50, shaded in the charts.',
        ],
      },
      {
        title: 'The plan from Day 50',
        extract: 'day-50', show: ['whatif'],
        bullets: [
          'Buy to 3 / 4 / 3, raise the reorder point to 6,000 and the order quantity to 26,700, prioritise step 4 at Station 2.',
          'Step up the contract only when lead times allow: $750, then $1,000, then $1,250.',
          'Each line is the median of 200 simulated futures, with a 10-90% band.',
        ],
      },
      {
        title: 'Days 51-64: the climb',
        extract: 'day-64', show: ['tiles', 'tele'],
        bullets: [
          'Day 51: three machines bought. Day 52: a 26,700-kit order, the last stockout.',
          'Contract 2 from Day 56, Contract 3 ($1,250) from Day 61, as the backlog cleared.',
          'Lead time fell from over 4 days to under half a day.',
        ],
      },
    ],
  },
  {
    title: 'Simulator drift',
    steps: [
      {
        title: 'Day 78: the first check',
        extract: 'day-78', show: ['drift'],
        bullets: [
          'Each new download was replayed through the model with the real daily orders.',
          'The average lead time matched, but revenue per job ran about $43 low: too many simulated jobs missed the half-day promise.',
          'Station 2 variability cut from 0.75 to 0.25. Lot splitting was checked and ruled out: one lot of 60 kits per job.',
        ],
      },
      {
        title: 'Day 198: the refit',
        extract: 'day-198', show: ['drift'],
        bullets: [
          'Over 138 post-restart days the model still ran about $16 a job low; the real result sat at its 93rd percentile.',
          'Refitted on about 2,000 jobs: Station 2 variability 0.5, Station 3 0.75.',
          'The real game moved back to the middle of the model\'s range, in time for the final order.',
        ],
      },
      {
        title: 'Over the whole game',
        extract: 'final-268', show: ['drift'],
        bullets: [
          'Every version of the model against all the days on the $1,250 contract.',
          'The first model was too pessimistic in every 20-day block; the final one tracks the real game.',
        ],
      },
    ],
  },
  {
    title: 'Final order',
    steps: [
      {
        title: 'Day 198: two ways to place it',
        extract: 'day-198', show: ['whatif'],
        bullets: [
          '9,310 kits on hand; the next automatic order of 26,100 would fire around Day 202.',
          'A: make that order the final one, about 53,300 kits. B: let it go, then a final order of about 27,200.',
          'Same cash either way, within $3,000. Skipping the final order would cost about $236,000 in wasted kits.',
        ],
      },
      {
        title: 'Day 200: sizing the order',
        extract: 'day-200', show: ['size'],
        bullets: [
          'Days 199-200 brought 39 orders instead of 30, so the size went up: the model said 898 batches, the Sheet 896.',
          'The best range was 893 to 898 batches. A few short hours at the very end cost less than worthless leftover kits.',
          'Placed on Day 200.37: 896 batches (53,760 kits), then order quantity and reorder point set to 0.',
        ],
      },
      {
        title: 'How it ended',
        extract: 'final-268', show: ['tiles', 'tele'],
        bullets: [
          'No day with jobs waiting for kits after the order.',
          '1,006 orders accepted on Days 201-268, 14.8 a day, close to the 15.0 we planned for.',
        ],
      },
    ],
  },
  {
    title: 'Competitors and result',
    steps: [
      {
        title: 'Watching the competition',
        extract: 'final-268', show: ['comp'],
        bullets: [
          'Leaderboard cash was typed into the Sheet; the download only has our own.',
          'Our Day 50-55 drop: three machines and the 26,700-kit order.',
          'Cash growth per day showed which contract each team was on.',
        ],
      },
      {
        title: 'Result',
        extract: 'final-268', show: ['result'],
        bullets: [
          'First place.',
          'Final cash inside the range projected on Day 200.',
        ],
      },
    ],
  },
];

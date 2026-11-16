# Littlefield event simulation (Python reference model)

The model behind the dashboard's what-if simulator. Phase 2 ports it to JavaScript;
this version is the reference the port must match. Python 3.9+ standard library only,
no installs.

```
cd sim
python3 -m unittest discover -s tests       # 24 checks, about 3 seconds
python3 -m littlefield validate             # replay Days 1-50 against the real game
python3 -m littlefield mixes                # machine-mix table
python3 -m littlefield project              # cash to Day 268 for the three presets
python3 -m littlefield final-order          # final kit order by day, 193 to 217
```

Every command takes a snapshot file (default `../test/fixtures/day50.json`). To start
from today, save the latest one while signed in to the dashboard
(`https://littlefield.jay.systems/api/snapshot`) and pass its path. Add `--json` for
machine-readable output, `--runs N` for more or fewer runs.

## What it models

| Rule | How |
|---|---|
| Demand | Poisson arrivals at the last 14 days' average (or `--demand`); a real day-by-day replay for validation |
| Route | Station 1 → Station 2 (step 2) → Station 3 → Station 2 (step 4) |
| Station 2 scheduling | FIFO, Prioritize Step 2, Prioritize Step 4 |
| Factory limit | Orders turned away at 100 unfinished jobs (jobs waiting for kits count) |
| Kits | 60 per job, taken when the job is accepted; jobs wait in order when there are none |
| Kit orders | Placed only when all four hold: kits on hand ≤ reorder point, no order on the way, cash ≥ one order's cost, quantity > 0. Arrive 4 days later |
| Contracts | Full revenue up to the quoted lead time, falling linearly to $0 at the maximum |
| Cash | Revenue on completion, kits and machines paid when bought, $10,000 per machine sold, 10% a year interest booked daily |
| Control | Settings can change until Day 218; the factory runs on until Day 268 |
| Final kit order | Size = kits for the jobs that can still finish by Day 268, less kits on hand and on order; placed by raising the reorder point, then the quantity goes to 0 |
| Contract ladder | Each day, move to the contract with the best expected revenue for a new order, using the work queued ahead and a 25% safety margin on lead time |

## Calibration (Days 1-50)

The real daily order counts are replayed through the model with the team's actual
settings. With the fitted values below the model reproduces, averaged over 40 runs:

| | Real game | Model |
|---|---|---|
| Kit order days | 9, 16, 25, 32, 41, 48 | 9, 16, 25, 32, 41, 48 (every run) |
| Stockouts start | Days 11, 18, 27, 34, 43, 50 | same waves, within a day |
| Average lead time | 2.87 days | 2.84 days |
| Queues, jobs (St1 / St2 / St3) | 20.1 / 3.6 / 8.3 | 20.2 / 3.6 / 7.9 |
| Utilization | 85% / 83% / 87% | 86% / 84% / 88% |
| Cash on Day 50 | $1,106,279 | $1,110,463 |

After the restart (`test/fixtures/day64.json`), the replay follows what the team did:
3/4/3 from Day 51, $1,000 contract from Day 56, $1,250 from Day 61, the 26,700-kit
order on Day 52. With no refitting:

| | Real game | Model |
|---|---|---|
| Revenue per job, Days 61-64 ($1,250 contract) | $1,163 | about $1,140 |
| Lead time, Days 61-64 | 0.41-0.50 days | 0.42-0.47 days |
| Cash on Day 64 | $792,147 | $792,886 |

The model drains the Day 50 backlog about half a day faster than the real factory did
(Days 50-58): it underestimates how long Station 1's queue was when it was overloaded.
That does not affect the decisions left, with the factory now below 70% utilization.

Fitted values (`python3 -m littlefield fit` repeats the search):

- **Process times** 0.1171 / 0.1749 / 0.1226 machine-days per job, measured from
  utilization. Station 3 is faster than the Settings tab's planning value of 0.128.
- **Variability** (0 = constant, 1 = exponential): Station 1 0.0, Station 2 0.75,
  Station 3 1.0. Station 2 and 3 are **not** nearly constant, which the plan assumed.
- **Step 2 share of Station 2 time**: 0.5. The data cannot tell 0.3 from 0.7.

## What the calibrated model says that differs from the Sheet

- At 3/4/3 the lead time is about the same as the Sheet's table (0.51 against 0.47 days),
  but revenue per job on the $1,250 contract is about **$1,050-1,070, not $1,199**,
  because variable process times push more jobs past the half-day promise. The $1,250
  contract still beats $1,000 at 3/4/3, by about $50 a job instead of $200.
- A fourth machine at Station 3 (3/4/4) or a fifth at Station 2 (3/5/3) adds about
  $50-60 a job on the $1,250 contract. Whether it pays for itself depends on the days left.
- With fully constant process times the model gives the Sheet's numbers back
  ($1,222 a job at 3/4/3), so the difference comes from the variability alone.

## Limits

- The starting state from a snapshot is estimated: the download gives daily averages,
  not individual jobs. See `snapshot.start_state`.
- Calibrated on Days 1-50 at 2/3/2 with stockouts. Check it against the post-restart days
  (new machines, new contract) by running `validate` on the latest snapshot: when machines
  or the contract changed, the replay follows what the team actually did, day by day,
  including the days kit orders were placed.
- The final order is sized to the expected demand; it does not add safety stock.

## For the JavaScript port

`rng.py` is mulberry32: the same seed gives the same numbers in JavaScript
(`tests/test_model.py` pins the first three values). Port `model.py` function by
function; with the same seed and constant process times, results should match exactly,
and with variability they should match in distribution.

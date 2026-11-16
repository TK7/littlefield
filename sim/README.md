# Littlefield event simulation (Python reference model)

The model behind the dashboard's what-if simulator. Phase 2 ports it to JavaScript;
this version is the reference the port must match. Python 3.9+ standard library only,
no installs.

```
cd sim
python3 -m unittest discover -s tests       # 32 checks, about 4 seconds
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

## Calibration

Two periods are replayed with the real daily order counts and the team's actual settings:
the congested Days 1-50 (2/3/2, stockouts, $750 contract) and the post-restart Days
61-78 (3/4/3, $1,250 contract, no stockouts). Averaged over 40 runs:

| Days 1-50 | Real game | Model |
|---|---|---|
| Kit order days | 9, 16, 25, 32, 41, 48 | 9, 16, 25, 32, 41, 48 (every run) |
| Stockouts start | Days 11, 18, 27, 34, 43, 50 | same waves, within a day |
| Average lead time | 2.87 days | 2.84 days |
| Queues, jobs (St1 / St2 / St3) | 20.1 / 3.6 / 8.3 | 20.2 / 2.8 / 8.7 |
| Utilization | 85% / 83% / 87% | 86% / 84% / 88% |
| Cash on Day 50 | $1,106,279 | $1,110,370 |

| Days 61-78, $1,250 contract (`test/fixtures/day78.json`) | Real game | Model |
|---|---|---|
| Revenue per job | $1,162 | $1,151 (10th to 90th percentile over 18 days: $1,115 to $1,176) |
| Average lead time | 0.454 days | 0.458 days |
| Days earning the full $1,250 | 2 of 18 (Days 69, 76) | about 1 of 18 |
| Cash on Day 78 | $1,022,984 | $1,023,951 |

Fitted values:

- **Process times** about 0.117 / 0.175 / 0.121 machine-days per job, measured from
  utilization in each snapshot. Station 3 is faster than the Settings tab's 0.128.
- **Variability** (0 = constant, 1 = exponential): Station 1 0.0, Station 2 0.25,
  Station 3 1.0.
- **Step 2 share of Station 2 time**: 0.3 (step 4 takes the larger part). It matches
  Station 2's queue on Days 1-50 better than 0.5 (2.8 against 2.3 jobs; real 3.6) and
  leaves Days 61-78 unchanged.
- **Lots**: each job enters the factory as one lot of 60 kits and is processed whole at
  each step, as the game's help page says and as the model does. The setup time is
  incurred once per lot, so it is already inside the measured process times.

### The Station 2 correction (Day 78)

Fitted on Days 1-50 alone, Station 2's variability came out at 0.75. Against the
post-restart days that setting gets the average lead time right (0.459 against 0.454
days) but revenue per job wrong: $1,119 against the real $1,162. Revenue depends on how
many jobs finish inside half a day, and 0.75 gave Station 2 too long a tail. No single
setting fits both periods exactly:

| Station 2 variability | Days 1-50: Station 2 queue (real 3.6) | Days 61-78: revenue per job (real $1,162) |
|---|---|---|
| 0.75 (before) | 3.8 | $1,119 |
| 0.5 | 2.8 | $1,140 |
| 0.25 (now) | 2.3 | $1,148 to $1,156 |

The rest of the game runs uncongested, so 0.25 is used, together with a 0.3 step 2 share.
Lot splitting was ruled out (one lot of 60 kits per job). Real days with an average lead
time below the sum of the process times (Day 76: 0.336 days) are within the model's
day-to-day range: with Station 3 fully random, many jobs finish faster than average, and
the quickest of 18 days in the model averages about 0.357 days. Over 18 days, revenue per
job varies by about $34 from luck alone, and the real $1,162 sits at the model's 58th
percentile, so no drift is measurable now.

Replaying a later snapshot now estimates the reorder point that was in force for each
past kit order from the stock levels on that day (`calibrate.order_rops`). Before, it used
the current setting for every past order, which moved Days 1-50 orders too early.

## What the calibrated model says that differs from the Sheet

- At 3/4/3 the lead time is about the same as the Sheet's table (0.47 against 0.47 days),
  but revenue per job on the $1,250 contract is about **$1,140-1,160, not $1,199**,
  because variable process times push some jobs past the half-day promise. Averaged over
  many days, no setting earns the full $1,250 a job, in the model or in the real game.
- At about 14 jobs a day, a fourth machine at Station 3 (3/4/4) or a fifth at Station 2
  (3/5/3) adds about $20-30 a job on the $1,250 contract: not enough to repay the machine
  over the days left.

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

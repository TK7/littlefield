"""Read a dashboard snapshot (the JSON the Google Sheet pushes) into simulation inputs.

The kit and contract inference follows public/derive.js, so the simulator starts from
the same numbers the dashboard and the Sheet show.
"""
import json

from .model import Config, StartState, ROUTE, FIFO, SCHEDULES

# Raw row columns (download columns A to X).
DAY, WAITING, ACC = 0, 1, (2, 3, 4)
Q, U, M = (5, 8, 11), (6, 9, 12), (7, 10, 13)
OUT, REV, LEAD, CASH = (14, 15, 16), (17, 18, 19), (20, 21, 22), 23


def load(path):
    with open(path) as f:
        return json.load(f)


def daily(snap):
    """Per-day facts from the raw rows, with kit orders inferred from cash like the Sheet does."""
    s = snap.get('settings', {})
    cfg = Config.from_settings(s)
    start_cash = s.get('startCash') or 1_000_000
    start_kits = s.get('startKits') or 9600
    threshold = s.get('kitThreshold') or 20000
    starts = [st.get('start') or d for st, d in zip(s.get('stations') or [{}, {}, {}], (2, 3, 2))]
    rows = sorted(snap['raw'], key=lambda r: r[DAY])
    out = []
    prev_cash, prev_m, prev_contract = start_cash, starts, None
    cum_acc = cum_ordered = 0
    for r in rows:
        accepted = sum(r[i] for i in ACC)
        completed = sum(r[i] for i in OUT)
        revenue = sum(r[o] * r[v] for o, v in zip(OUT, REV))
        lead_sum = sum(r[o] * r[l] for o, l in zip(OUT, LEAD))
        cash = r[CASH] * 1000
        mach = [r[i] for i in M]
        contract = prev_contract
        if accepted > 0:
            contract = max(range(3), key=lambda k: (r[ACC[k]], -k)) + 1
        spend = prev_cash * (1 + cfg.daily_rate) + revenue - cash
        machine_spend = 0.0
        for k in range(3):
            bought = max(0, _ceil3(mach[k]) - _ceil3(prev_m[k]))
            sold = max(0, _floor3(prev_m[k]) - _floor3(mach[k]))
            machine_spend += bought * cfg.prices[k] - sold * cfg.resale
        kit_spend = spend - machine_spend
        ordered = 0
        if kit_spend > threshold:
            ordered = int(round((kit_spend - cfg.order_fee) / cfg.kit_cost / 10) * 10)
        cum_acc += accepted
        cum_ordered += ordered
        out.append({
            'day': int(r[DAY]), 'accepted': accepted, 'completed': completed, 'revenue': revenue,
            'lead': lead_sum / completed if completed else None, 'waiting': r[WAITING],
            'queue_kits': [r[i] for i in Q], 'util': [r[i] for i in U], 'machines': mach,
            'cash': cash, 'contract': contract, 'kits_ordered': ordered,
            'kit_position': start_kits + cum_ordered - cfg.kits_per_job * cum_acc,
            'wip': None,
        })
        out[-1]['cum_accepted'] = cum_acc
        prev_cash, prev_m, prev_contract = cash, mach, contract
    done = 0
    for d in out:
        done += d['completed']
        d['wip'] = d['cum_accepted'] - done
    return out


def _ceil3(x):
    import math
    return math.ceil(round(x, 3))


def _floor3(x):
    import math
    return math.floor(round(x, 3))


def replay_arrivals(days, rng):
    """Arrival times that reproduce the real daily accepted counts, spread at random within each day."""
    times = []
    for d in days:
        n = int(d['accepted'])
        times.extend(sorted((d['day'] - 1) + rng.random() for _ in range(n)))
    return times


def schedule_rule(text):
    """The Settings tab's scheduling cell ('FIFO', 'Step 4', 'Prioritize Step 2', ...) as a model rule."""
    t = str(text or '').strip().lower()
    if t in (r.lower() for r in SCHEDULES):
        return next(r for r in SCHEDULES if r.lower() == t)
    if '4' in t:
        return SCHEDULES[2]
    if '2' in t:
        return SCHEDULES[1]
    return FIFO


def start_state(snap, demand=None):
    """Estimated factory state at the end of the latest day in the snapshot.

    The download gives daily averages, not individual jobs, so this is an estimate:
    - jobs waiting for kits come from the kit position (exact at end of day);
    - the other jobs in the factory are spread over the stations in proportion to the
      day's average queues plus busy machines, with Station 2's queue split evenly
      between step 2 and step 4;
    - acceptance times are spaced at the demand rate, oldest at the furthest step.
    """
    days = daily(snap)
    cfg = Config.from_settings(snap.get('settings', {}))
    s = snap.get('settings', {})
    last = days[-1]
    day = last['day']
    rate = demand or (sum(d['accepted'] for d in days[-14:]) / min(14, len(days)))

    lead = cfg.kit_lead
    recent = [d for d in days if d['kits_ordered'] and d['day'] > day - lead]
    on_order = sum(d['kits_ordered'] for d in recent)
    position = last['kit_position']
    kits = max(0, position - on_order)
    waiting_jobs = max(0, round((on_order - position) / cfg.kits_per_job)) if position < on_order else 0
    order_arrives = None
    if recent:
        order_arrives = recent[-1]['day'] - 0.5 + lead  # placed some time during that day

    machines = tuple(max(1, round(m)) for m in last['machines'])
    in_stations = max(0, int(last['wip']) - waiting_jobs)
    weight = [last['queue_kits'][k] / cfg.kits_per_job + machines[k] * last['util'][k] for k in range(3)]
    total = sum(weight) or 1.0
    per_station = [int(round(in_stations * w / total)) for w in weight]
    per_station[0] += in_stations - sum(per_station)  # rounding remainder

    # Furthest step first = oldest job.
    placed = []
    for _ in range(per_station[1] // 2):
        placed.append(3)
    for _ in range(per_station[2]):
        placed.append(2)
    for _ in range(per_station[1] - per_station[1] // 2):
        placed.append(1)
    for _ in range(per_station[0]):
        placed.append(0)
    placed += ['kits'] * waiting_jobs
    n = len(placed)
    contract = last['contract'] or 1
    jobs = [(day - (n - i) / rate, contract, where) for i, where in enumerate(placed)]

    sched = schedule_rule(s.get('sched'))
    return StartState(
        day=day, cash=last['cash'], machines=machines, kits=int(kits),
        order_arrives=order_arrives, order_qty=int(on_order) if recent else 0,
        contract=contract, rop=int(s.get('rop') or 0), qty=int(s.get('q') or 0), schedule=sched, jobs=jobs,
    )


def measured_ptimes(snap):
    """Machine-days per job at each station, measured from utilization over the whole download.

    Busy machine-days divided by the jobs each station has worked on: all completed jobs
    plus the unfinished jobs already past that station at the end (estimated from the
    last day's queues, as in start_state).
    """
    days = daily(snap)
    st = start_state(snap)
    done = sum(d['completed'] for d in days)
    steps = [j[2] for j in st.jobs if j[2] != 'kits']
    past = [sum(1 for w in steps if w >= 1), sum(1 for w in steps if w >= 2), sum(1 for w in steps if w >= 3)]
    busy = [sum(d['util'][k] * d['machines'][k] for d in days) for k in range(3)]
    # Station 2 does two visits per job: count a job past step 2 as half done there.
    jobs = [done + past[0], done + past[1] * 0.5, done + past[2]]
    return tuple(round(busy[k] / jobs[k], 4) if jobs[k] else None for k in range(3))


def config(snap, measured=True, **overrides):
    """Model settings from the snapshot. With measured=True the process times come from
    the data rather than the Settings tab's planning values."""
    cfg = Config.from_settings(snap.get('settings', {}))
    if measured and 'ptimes' not in overrides:
        m = measured_ptimes(snap)
        if all(m):
            overrides['ptimes'] = m
    return Config(**{**cfg.__dict__, **overrides})


assert len(ROUTE) == 4

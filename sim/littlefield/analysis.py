"""The questions the plan and the dashboard ask of the model."""
import math
import statistics as st

from .model import Config, Policy, StartState, simulate, revenue_for, FIFO, PRIORITY_STEP4, ROUTE

MIXES = [(2, 3, 2), (2, 3, 3), (3, 3, 3), (2, 4, 3), (3, 4, 3), (3, 4, 4), (3, 5, 3), (4, 5, 4)]


def pct(xs, p):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


# ------------------------------------------------------------------ steady state
def steady(cfg, mix, demand=15.5, schedule=PRIORITY_STEP4, runs=20, warmup=20, days=60, seed=1):
    """Lead times for a machine mix with kits never short and demand held constant."""
    c = Config(**{**cfg.__dict__, 'game_end': warmup + days, 'control_end': warmup + days})
    start = StartState(day=0, cash=1e12, machines=mix, kits=10 ** 9, rop=0, qty=0, schedule=schedule)
    leads, util, rejected, done = [], [[], [], []], 0, 0
    for k in range(runs):
        r = simulate(c, Policy(), start, seed=seed + k, demand=demand)
        for d in r['days'][warmup:]:
            leads.extend(d['leads'])
            rejected += d['rejected']
            done += d['completed']
            for s in range(3):
                util[s].append(d['util'][s])
    out = {
        'mix': mix, 'demand': demand, 'lead_mean': st.mean(leads), 'lead_p90': pct(leads, 0.9),
        'util': [st.mean(u) for u in util], 'rejected_per_day': rejected / (runs * days),
        'jobs_per_day': done / (runs * days),
    }
    for n, contract in cfg.contracts.items():
        out['rev_c%d' % n] = st.mean(revenue_for(contract, x) for x in leads)
    return out


def mix_table(cfg, demand=15.5, schedule=PRIORITY_STEP4, runs=20, mixes=MIXES, current=(2, 3, 2), days_left=168):
    """The Sheet's machine-mix table, from the simulation.

    Value over the rest of the game = (revenue per job on the best contract - kit cost per job)
    x jobs per day x days left - machines still to buy. Interest is left out, as in the Sheet.
    """
    kit_cost = cfg.kits_per_job * cfg.kit_cost
    rows = []
    for mix in mixes:
        r = steady(cfg, mix, demand, schedule, runs)
        best = max(cfg.contracts, key=lambda n: r['rev_c%d' % n])
        buy = sum(max(0, mix[s] - current[s]) * cfg.prices[s] for s in range(3))
        margin = (r['rev_c%d' % best] - kit_cost) * r['jobs_per_day']
        r.update(best=best, daily_margin=margin, machines_to_buy=buy, value=margin * days_left - buy)
        rows.append(r)
    return rows


def sweep(cfg, mix, demands=range(8, 21), schedule=PRIORITY_STEP4, runs=10):
    """Lead time against bottleneck utilization (Visual 2), demand 8 to 20 jobs a day."""
    out = []
    for lam in demands:
        r = steady(cfg, mix, lam, schedule, runs)
        r['bottleneck'] = max(r['util'])
        r['mmc_upper'] = mmc_lead(cfg, mix, lam)
        out.append(r)
    return out


# ------------------------------------------------------------------ textbook bound
def erlang_c_wait(lam, mu, c):
    """M/M/c mean wait in queue (days). None if the station is overloaded."""
    a = lam / mu
    rho = a / c
    if rho >= 1:
        return None
    s = sum(a ** k / math.factorial(k) for k in range(c))
    top = a ** c / math.factorial(c) / (1 - rho)
    pw = top / (s + top)
    return pw / (c * mu - lam)


def mmc_lead(cfg, mix, lam):
    """Lead time if every station were M/M/c (exponential process times). An upper bound for our factory."""
    total = 0.0
    for s in range(3):
        visits = 2 if s == 1 else 1
        per_visit = cfg.ptimes[s] / visits
        w = erlang_c_wait(lam * visits, 1 / per_visit, mix[s])
        if w is None:
            return None
        total += visits * (w + per_visit)
    return total


# ------------------------------------------------------------------ projections to Day 268
def presets(start, cfg, rop=6000, qty=26700, final_day=None):
    """The dashboard's three preset lines, starting from `start`."""
    d = start.day + 1
    keep = Policy()  # no changes at all, so no final order either
    safe = Policy(machines={d: (3, 4, 3)}, rop={d: rop}, qty={d: qty}, schedule={d: PRIORITY_STEP4},
                  ladder=True, ladder_top=2, final_day=final_day)
    rec = Policy(machines={d: (3, 4, 3)}, rop={d: rop}, qty={d: qty}, schedule={d: PRIORITY_STEP4},
                 ladder=True, ladder_top=3, final_day=final_day)
    return {'Do nothing': keep, 'Safe (3/4/3, up to $1,000)': safe, 'Recommended (3/4/3, up to $1,250)': rec}


def project(start, cfg, policy, demand=15.5, runs=200, seed=1):
    """Median and 10th-90th percentile cash by day, and the spread of Day 268 cash.

    Every policy uses the same seeds, so differences between policies are not demand noise.
    """
    res = [simulate(cfg, policy, start, seed=seed + k, demand=demand) for k in range(runs)]
    n = min(len(r['days']) for r in res)
    by_day = []
    for i in range(n):
        cash = [r['days'][i]['cash'] for r in res]
        by_day.append({'day': res[0]['days'][i]['day'], 'p10': pct(cash, 0.1), 'p50': pct(cash, 0.5), 'p90': pct(cash, 0.9)})
    final = [r['final_cash'] for r in res]
    switches = []
    for r in res:
        seen, prev = {}, start.contract
        for d in r['days']:
            if d['contract'] != prev:
                seen.setdefault(d['contract'], d['day'])
                prev = d['contract']
        switches.append(seen)
    return {
        'by_day': by_day, 'final_p10': pct(final, 0.1), 'final_p50': pct(final, 0.5), 'final_p90': pct(final, 0.9),
        'kits_left_p50': pct([r['kits_left'] for r in res], 0.5),
        'blocked': sum(1 for r in res if r['blocked']) / runs,
        'switch_day_p50': {c: pct([s[c] for s in switches if c in s], 0.5) for c in (2, 3)},
        'runs': res,
    }


# ------------------------------------------------------------------ final kit order
def final_order(start, cfg, base_policy, days=range(193, 218), demand=15.5, runs=60, seed=1):
    """For each candidate day: does the final order go through, how big is it, and what does it leave.

    The order only goes through when all four Littlefield conditions hold at some moment
    after the settings change, so the run tells us whether it would have fired before
    control ends, and when.
    """
    out = []
    for day in days:
        pol = Policy(**{**base_policy.__dict__, 'final_day': day, 'final_qty': None})
        res = [simulate(cfg, pol, start, seed=seed + k, demand=demand) for k in range(runs)]
        fired, sizes, when, short, left, cash = 0, [], [], [], [], []
        for r in res:
            final = [(t, q) for t, q in r['orders'] if t >= day - 1]
            if final:
                fired += 1
                t, q = final[0]
                sizes.append(q)
                when.append(t)
            left.append(r['kits_left'])
            cash.append(r['final_cash'])
            short.append(sum(d['waiting'] for d in r['days'] if d['day'] > day))
        out.append({
            'day': day, 'fires': fired / runs, 'size_p50': pct(sizes, 0.5), 'cost_p50': (pct(sizes, 0.5) or 0) * cfg.kit_cost + cfg.order_fee,
            'placed_p50': pct(when, 0.5), 'kits_left_p50': pct(left, 0.5), 'job_days_waiting_p50': pct(short, 0.5),
            'final_cash_p50': pct(cash, 0.5), 'final_cash_p10': pct(cash, 0.1),
        })
    return out


FINAL_ORDER_STEPS = [
    'Check in Littlefield that no kit order is on the way. If one is, wait for it to arrive: an order cannot be placed while another is in transit.',
    'Check cash is at least (order size x $10) + $1,000. If not, the order will not be placed: wait, or reduce the size.',
    'Set the order quantity to the final order size.',
    'Raise the reorder point above current inventory (for example 999,999) so the order fires at once.',
    'Within the hour, once the order shows as placed, set the order quantity to 0 so no further order is made.',
]

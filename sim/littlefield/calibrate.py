"""Check the model against the real game and fit its two unknowns.

Replay: the real number of orders accepted each day is fed in (times within a day are
random), with the settings the team actually had. The model must then reproduce what
Littlefield reported: kit order days, stockouts, lead times, queues, utilization, cash.

Unknowns fitted here (everything else comes from the Settings tab):
  cv           variability of process times at each station
  step2_share  share of Station 2's time spent on step 2 rather than step 4
"""
import itertools
import math
import statistics as st

from .model import Config, Policy, StartState, simulate
from .rng import Rng
from . import snapshot as S


def order_rops(real, kit_lead=4.0, start_kits=9600):
    """Estimate the reorder point in force when each past kit order fired.

    The download does not record settings. An order fired during day d, so the reorder
    point was below the kits on hand at the end of day d-1 and at or above the lowest
    level reached during day d (about the end-of-day level). The midpoint is used.
    """
    def on_hand(i):
        d = real[i]
        on_order = sum(x['kits_ordered'] for x in real[:i + 1] if x['kits_ordered'] and x['day'] > d['day'] - kit_lead)
        return d['kit_position'] - on_order
    out = {}
    for i, d in enumerate(real):
        if not d['kits_ordered']:
            continue
        before = on_hand(i - 1) if i > 0 else start_kits
        after = max(0, on_hand(i))
        out[d['day']] = max(0, int(round((max(before, after) + after) / 2)))
    return out


def history_policy(real, rop=None):
    """What the team actually did, read from the data: machine counts, contract, kit orders.

    Used to replay periods with changes (for example after the Day 50 restart). Kit orders
    are placed on the days they were detected, not by the reorder rule, so the replay tests
    the factory model rather than the inferred settings.
    """
    pol = Policy(placed_orders={d['day']: int(d['kits_ordered']) for d in real if d['kits_ordered']},
                 placed_rop=order_rops(real) if rop is None else rop)
    prev_m, prev_c = None, None
    for d in real:
        m = tuple(max(1, math.ceil(round(x, 3))) for x in d['machines'])
        if m != prev_m:
            pol.machines[d['day']] = m
            prev_m = m
        if d['contract'] and d['contract'] != prev_c:
            pol.contract[d['day']] = d['contract']
            prev_c = d['contract']
    return pol


def changed(real):
    """True when machines or the contract changed during the period."""
    pol = history_policy(real)
    return len(pol.machines) > 1 or len(pol.contract) > 1


def replay(snap, cfg, runs=20, seed=1, start=None, policy=None, history=None):
    """Run the real arrivals through the model `runs` times.

    history=None uses the team's actual machines, contracts and kit order days when any
    of them changed in the data, and the Settings tab's reorder rule otherwise.
    """
    real = S.daily(snap)
    if policy is None:
        if history is None:
            history = changed(real)
        if history:
            policy = history_policy(real)
            # Machines bought for day 1 count as the starting mix; no reorder rule.
            m1 = policy.machines.pop(real[0]['day'], None)
            start = start or StartState(machines=m1 or (2, 3, 2), rop=0, qty=0)
        else:
            policy = Policy()
    out = []
    for k in range(runs):
        arr = S.replay_arrivals(real, Rng(10_000 + seed + k))
        out.append(simulate(cfg, policy, start or StartState(), seed=seed + k, arrivals=arr))
    return real, out


def compare(real, runs):
    """Real against mean simulated, day by day and in total."""
    n = len(real)
    mean = lambda xs: st.mean(xs) if xs else None
    rows = []
    for i, d in enumerate(real):
        leads = [r['days'][i]['lead'] for r in runs if r['days'][i]['lead'] is not None]
        rows.append({
            'day': d['day'], 'lead_real': d['lead'], 'lead_sim': mean(leads),
            'queue_real': [q / 60 for q in d['queue_kits']],
            'queue_sim': [mean([r['days'][i]['queue'][k] for r in runs]) for k in range(3)],
            'util_real': d['util'], 'util_sim': [mean([r['days'][i]['util'][k] for r in runs]) for k in range(3)],
            'waiting_real': d['waiting'], 'waiting_sim': mean([r['days'][i]['waiting'] for r in runs]),
        })
    pairs = [(r['lead_real'], r['lead_sim']) for r in rows if r['lead_real'] and r['lead_sim']]
    summary = {
        'lead_rmse': math.sqrt(st.mean([(a - b) ** 2 for a, b in pairs])),
        'lead_bias': st.mean([b - a for a, b in pairs]),
        'lead_mean_real': st.mean([a for a, _ in pairs]),
        'lead_mean_sim': st.mean([b for _, b in pairs]),
        'queue_real': [st.mean(r['queue_real'][k] for r in rows) for k in range(3)],
        'queue_sim': [st.mean(r['queue_sim'][k] for r in rows) for k in range(3)],
        'util_real': [st.mean(r['util_real'][k] for r in rows) for k in range(3)],
        'util_sim': [st.mean(r['util_sim'][k] for r in rows) for k in range(3)],
        'cash_real': real[-1]['cash'],
        'cash_sim': st.mean(r['final_cash'] for r in runs),
        'order_days_real': [d['day'] for d in real if d['kits_ordered']],
        'order_days_sim': sorted({math.ceil(t) for r in runs for t, _ in r['orders']}),
        'order_days_each': [[math.ceil(t) for t, _ in r['orders']] for r in runs],
        'days': n,
    }
    return rows, summary


def contract_period(real, runs, contract=3):
    """Real against simulated revenue per job and lead time on the days a contract took orders.

    The comparison that matters for the rest of the game: revenue per job depends on the
    whole lead-time distribution, not just its average.
    """
    idx = [i for i, d in enumerate(real) if d['contract'] == contract and d['completed']]
    if not idx:
        return None
    done_real = sum(real[i]['completed'] for i in idx)
    done_sim = sum(r['days'][i]['completed'] for r in runs for i in idx)
    full = sum(1 for r in runs for i in idx for x in r['days'][i]['leads'] if x <= 0.5)
    return {
        'days': [real[i]['day'] for i in idx],
        'rev_real': sum(real[i]['revenue'] for i in idx) / done_real,
        'rev_sim': sum(r['days'][i]['revenue'] for r in runs for i in idx) / done_sim,
        'lead_real': sum(real[i]['lead'] * real[i]['completed'] for i in idx) / done_real,
        'lead_sim': sum(x for r in runs for i in idx for x in r['days'][i]['leads']) / done_sim,
        'share_within_half_day_sim': full / done_sim,
    }


def score(summary):
    """One number to minimise: lead-time error plus queue error at each station (in days of lead time)."""
    q = sum(abs(a - b) for a, b in zip(summary['queue_real'], summary['queue_sim'])) / 15.5
    return summary['lead_rmse'] + q


def fit(snap, runs=12, cvs=(0.0, 0.25, 0.5, 0.75, 1.0), shares=(0.3, 0.5, 0.7), log=None):
    base = S.config(snap)
    best = None
    for cv1, cv2, cv3, share in itertools.product(cvs, cvs, cvs, shares):
        cfg = Config(**{**base.__dict__, 'cv': (cv1, cv2, cv3), 'step2_share': share})
        real, out = replay(snap, cfg, runs=runs)
        _, summ = compare(real, out)
        sc = score(summ)
        if log:
            log('cv=%s share=%.1f score=%.3f lead_rmse=%.3f' % ((cv1, cv2, cv3), share, sc, summ['lead_rmse']))
        if best is None or sc < best[0]:
            best = (sc, cfg, summ)
    return best

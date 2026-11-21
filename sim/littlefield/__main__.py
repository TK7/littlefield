"""Command line.  Run from the sim/ folder:

  python3 -m littlefield validate     [snapshot.json]   replay Days 1-N against the real game
  python3 -m littlefield fit          [snapshot.json]   re-fit process-time variability (about 1 minute)
  python3 -m littlefield mixes        [snapshot.json]   the machine-mix table
  python3 -m littlefield project      [snapshot.json]   cash to Day 268 for the presets, from the snapshot day
  python3 -m littlefield final-order  [snapshot.json]   final kit order by day, 193 to 217

Options: --runs N, --demand X (jobs a day; default = last 14 days), --json
The snapshot defaults to ../test/fixtures/day50.json. Use the latest one from the dashboard
(https://littlefield.jay.systems/api/snapshot) to start from today's state.
"""
import argparse
import json
import os
import sys

from . import analysis as A
from . import calibrate as C
from . import snapshot as S
from .model import Policy, simulate

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SNAPSHOT = os.path.join(HERE, '..', '..', 'test', 'fixtures', 'day50.json')


def usd(x):
    return 'n/a' if x is None else '${:,.0f}'.format(x)


def main(argv=None):
    ap = argparse.ArgumentParser(prog='python3 -m littlefield', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('command', choices=['validate', 'fit', 'mixes', 'project', 'final-order'])
    ap.add_argument('snapshot', nargs='?', default=DEFAULT_SNAPSHOT)
    ap.add_argument('--runs', type=int, default=None)
    ap.add_argument('--demand', type=float, default=None)
    ap.add_argument('--rop', type=int, default=None, help='reorder point set in Littlefield now (default: Settings tab)')
    ap.add_argument('--qty', type=int, default=None, help='order quantity set in Littlefield now (default: Settings tab)')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)

    snap = S.load(a.snapshot)
    cfg = S.config(snap)
    days = S.daily(snap)
    # Demand: --demand, else the Settings tab's planning demand, else the last 14 days.
    plan = (snap.get('settings') or {}).get('demandPlan') or 0
    demand = a.demand or plan or sum(d['accepted'] for d in days[-14:]) / min(14, len(days))
    out = None

    if a.command == 'validate':
        real, runs = C.replay(snap, cfg, runs=a.runs or 40)
        _, s = C.compare(real, runs)
        s['mode'] = 'actual machines, contracts and kit order days' if C.changed(real) else 'Settings tab reorder rule'
        s['contract3'] = C.contract_period(real, runs)
        s.pop('order_days_each')
        out = s
        if not a.json:
            print('Replay of Days 1-%d, %d runs, process times %s, variability %s' % (s['days'], a.runs or 40, cfg.ptimes, cfg.cv))
            print('  following: %s' % s['mode'])
            print('  kit order days     real %s   model %s' % (s['order_days_real'], s['order_days_sim']))
            print('  lead time (days)   real %.2f   model %.2f   error per day %.2f' % (s['lead_mean_real'], s['lead_mean_sim'], s['lead_rmse']))
            for k in range(3):
                print('  Station %d          queue real %5.1f model %5.1f   utilization real %3.0f%% model %3.0f%%' % (
                    k + 1, s['queue_real'][k], s['queue_sim'][k], 100 * s['util_real'][k], 100 * s['util_sim'][k]))
            print('  cash on Day %d     real %s   model %s' % (s['days'], usd(s['cash_real']), usd(s['cash_sim'])))
            c3 = C.contract_period(real, runs)
            if c3:
                print('  $1,250 contract, Days %d-%d: revenue per job real %s model %s; lead time real %.3f model %.3f days' % (
                    c3['days'][0], c3['days'][-1], usd(c3['rev_real']), usd(c3['rev_sim']), c3['lead_real'], c3['lead_sim']))

    elif a.command == 'fit':
        sc, best, s = C.fit(snap, runs=a.runs or 8, log=None if a.json else print)
        out = {'cv': best.cv, 'step2_share': best.step2_share, 'score': sc}
        if not a.json:
            print('Best: cv=%s step2_share=%.1f score=%.3f' % (best.cv, best.step2_share, sc))

    elif a.command == 'mixes':
        start = S.start_state(snap)
        left = max(0, cfg.game_end - start.day)
        rows = A.mix_table(cfg, demand, runs=a.runs or 20, current=start.machines, days_left=left)
        out = rows
        if not a.json:
            print('Demand %.1f jobs a day, Prioritize Step 4, kits never short, %d days left' % (demand, left))
            print('%-6s %6s %6s %8s %8s %8s %5s %10s %11s' % ('Mix', 'Lead', 'p90', '$750', '$1,000', '$1,250', 'Best', 'To buy', 'Value'))
            for r in rows:
                print('%-6s %6.2f %6.2f %8s %8s %8s %5s %10s %11s' % ('/'.join(map(str, r['mix'])), r['lead_mean'], r['lead_p90'],
                      usd(r['rev_c1']), usd(r['rev_c2']), usd(r['rev_c3']), 'C%d' % r['best'], usd(r['machines_to_buy']), usd(r['value'])))

    elif a.command == 'project':
        start = S.start_state(snap)
        out = {}
        for name, pol in A.presets(start, cfg, final_day=210).items():
            p = A.project(start, cfg, pol, demand, runs=a.runs or 100)
            p.pop('runs')
            out[name] = p
        if not a.json:
            print('From Day %d, demand %.1f jobs a day, final kit order on Day 210, %d runs' % (start.day, demand, a.runs or 100))
            for name, p in out.items():
                sw = ', '.join('C%d on Day %.0f' % (c, d) for c, d in p['switch_day_p50'].items() if d)
                print('  %-36s Day 268 cash %s (10%%-90%%: %s to %s)%s' % (
                    name, usd(p['final_p50']), usd(p['final_p10']), usd(p['final_p90']), ('   switches: ' + sw) if sw else ''))

    elif a.command == 'final-order':
        start = S.start_state(snap, demand=demand)
        if a.rop is not None:
            start.rop = a.rop
        if a.qty is not None:
            start.qty = a.qty
        base = Policy()   # keep today's settings; only the final order changes
        first = max(193, start.day + 1)
        last = cfg.control_end - 1
        near = last - first <= 24
        runs = a.runs or (300 if near else 40)
        rows = A.final_order(start, cfg, base, days=range(first, last + 1, 1 if near else 4), demand=demand, runs=runs)
        nxt = [next(((t, q) for t, q in r['orders'] if t >= start.day), None)
               for r in (simulate(cfg, base, start, seed=1 + k, demand=demand) for k in range(min(runs, 100)))]
        nxt = [x for x in nxt if x]
        out = {'rows': rows, 'steps': A.FINAL_ORDER_STEPS, 'demand': demand, 'rop': start.rop, 'qty': start.qty,
               'next_automatic_order_day_p50': A.pct([t for t, _ in nxt], 0.5) if nxt else None}
        if not a.json:
            print('Final kit order from Day %d: demand %.1f jobs a day, reorder point %s, order quantity %s, %d runs a day'
                  % (start.day, demand, '{:,}'.format(start.rop), '{:,}'.format(start.qty), runs))
            print('Kits on hand %s, %s.' % ('{:,}'.format(start.kits),
                  'order of %s on the way, due about Day %.1f' % ('{:,}'.format(start.order_qty), start.order_arrives) if start.order_arrives else 'no order on the way'))
            if nxt:
                print('If nothing changes, the next automatic order (%s kits) fires around Day %.1f.' % ('{:,}'.format(nxt[0][1]), A.pct([t for t, _ in nxt], 0.5) + 1))
            print('%5s %7s %8s %9s %11s %10s %15s %15s' % ('Day', 'Fires', 'Placed', 'Kits', 'Cost', 'Kits left', 'Cash p50', 'Cash p10'))
            for r in rows:
                print('%5d %6.0f%% %8.1f %9s %11s %10s %15s %15s' % (r['day'], 100 * r['fires'], (r['placed_p50'] or 0) + 1, '{:,.0f}'.format(r['size_p50'] or 0),
                      usd(r['cost_p50']), '{:,.0f}'.format(r['kits_left_p50']), usd(r['final_cash_p50']), usd(r['final_cash_p10'])))
            print('"Placed" is the day the order actually goes in: later than the settings change when an order is on the way.')
            print('\nHow to place it:')
            for i, step in enumerate(A.FINAL_ORDER_STEPS, 1):
                print('  %d. %s' % (i, step))

    if a.json:
        json.dump(out, sys.stdout, indent=1, default=str)
        print()


if __name__ == '__main__':
    main()

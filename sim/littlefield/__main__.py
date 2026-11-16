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
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)

    snap = S.load(a.snapshot)
    cfg = S.config(snap)
    days = S.daily(snap)
    demand = a.demand or sum(d['accepted'] for d in days[-14:]) / min(14, len(days))
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
        start = S.start_state(snap)
        base = A.presets(start, cfg)['Recommended (3/4/3, up to $1,250)']
        first = max(193, start.day + 1)
        rows = A.final_order(start, cfg, base, days=range(first, 218, 4 if first < 214 else 1), demand=demand, runs=a.runs or 40)
        out = {'rows': rows, 'steps': A.FINAL_ORDER_STEPS}
        if not a.json:
            print('Final kit order, Recommended settings, demand %.1f jobs a day' % demand)
            print('%5s %7s %9s %11s %12s %14s' % ('Day', 'Fires', 'Kits', 'Cost', 'Kits left', 'Day 268 cash'))
            for r in rows:
                print('%5d %6.0f%% %9s %11s %12s %14s' % (r['day'], 100 * r['fires'], '{:,.0f}'.format(r['size_p50'] or 0),
                      usd(r['cost_p50']), '{:,.0f}'.format(r['kits_left_p50']), usd(r['final_cash_p50'])))
            print('\nHow to place it:')
            for i, step in enumerate(A.FINAL_ORDER_STEPS, 1):
                print('  %d. %s' % (i, step))

    if a.json:
        json.dump(out, sys.stdout, indent=1, default=str)
        print()


if __name__ == '__main__':
    main()

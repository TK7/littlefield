"""Write reference results for the JavaScript port (test/fixtures/sim-golden.json).

  cd sim && python3 -m littlefield.golden

test/sim.mjs runs the same scenarios through public/sim/ and compares day by day.
Rerun this whenever model.py or snapshot.py changes.
"""
import json
import os

from . import snapshot as S
from .model import Config, Policy, StartState, simulate, PRIORITY_STEP4
from .rng import Rng

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
FIX = os.path.join(ROOT, 'test', 'fixtures')


def run_out(r):
    keys = ('day', 'accepted', 'rejected', 'completed', 'revenue', 'lead', 'waiting', 'queue', 'util', 'cash', 'kits', 'wip', 'contract')
    return {
        'days': [{k: d[k] for k in keys} for d in r['days']],
        'orders': r['orders'], 'purchases': r['purchases'], 'final_cash': r['final_cash'],
        'kits_left': r['kits_left'], 'wip_left': r['wip_left'],
    }


def start_out(st):
    return {'day': st.day, 'cash': st.cash, 'machines': list(st.machines), 'kits': st.kits,
            'order_arrives': st.order_arrives, 'order_qty': st.order_qty, 'contract': st.contract,
            'rop': st.rop, 'qty': st.qty, 'schedule': st.schedule, 'jobs': [list(j) for j in st.jobs]}


def main():
    out = {'snapshots': {}, 'runs': {}}
    for name in ('day50', 'day59-synthetic', 'day64'):
        snap = S.load(os.path.join(FIX, name + '.json'))
        out['snapshots'][name] = {
            'daily': [{k: d[k] for k in ('day', 'kits_ordered', 'kit_position', 'wip', 'contract')} for d in S.daily(snap)],
            'start': start_out(S.start_state(snap)),
            'ptimes': list(S.measured_ptimes(snap)),
        }

    # A: a whole game from Day 0 with purchases, the contract ladder and a final order.
    pol = Policy(machines={30: (3, 4, 3)}, rop={30: 6000}, qty={30: 26700}, schedule={30: PRIORITY_STEP4},
                 ladder=True, final_day=200)
    out['runs']['A'] = {'seed': 11, 'demand': 15.5, 'result': run_out(simulate(Config(), pol, StartState(), seed=11, demand=15.5))}

    # B: from the Day 64 snapshot, keeping settings, final order on Day 210.
    snap = S.load(os.path.join(FIX, 'day64.json'))
    r = simulate(S.config(snap), Policy(final_day=210), S.start_state(snap), seed=4, demand=13.6)
    out['runs']['B'] = {'seed': 4, 'demand': 13.6, 'result': run_out(r)}

    # C: replay of Days 1-50 with the real daily order counts.
    snap = S.load(os.path.join(FIX, 'day50.json'))
    arr = S.replay_arrivals(S.daily(snap), Rng(10001))
    out['runs']['C'] = {'seed': 1, 'arrivals_seed': 10001, 'result': run_out(simulate(S.config(snap), Policy(), StartState(), seed=1, arrivals=arr))}

    # D: history replay of Days 1-78 (machines, contracts, kit orders as they happened).
    from . import calibrate as C
    snap = S.load(os.path.join(FIX, 'day78.json'))
    real, runs = C.replay(snap, S.config(snap), runs=3, seed=1)
    out['runs']['D'] = {'result': [run_out(r) for r in runs], 'contract3': C.contract_period(real, runs),
                        'order_rops_day198': C.order_rops(S.daily(S.load(os.path.join(FIX, 'day198.json'))))}

    with open(os.path.join(FIX, 'sim-golden.json'), 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print('wrote', os.path.join(FIX, 'sim-golden.json'))


if __name__ == '__main__':
    main()

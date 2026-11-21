"""Run from sim/:  python3 -m unittest discover -s tests -v"""
import math
import os
import unittest

from littlefield import analysis as A
from littlefield import calibrate as C
from littlefield import snapshot as S
from littlefield.model import Config, Policy, StartState, simulate, revenue_for, FIFO, PRIORITY_STEP4
from littlefield.rng import Rng

FIXTURES = os.path.join(os.path.dirname(__file__), '..', '..', 'test', 'fixtures')
DAY50 = S.load(os.path.join(FIXTURES, 'day50.json'))


class RngTest(unittest.TestCase):
    def test_matches_javascript_mulberry32(self):
        # Same values as mulberry32(42) in JavaScript; the dashboard port must reproduce them.
        r = Rng(42)
        self.assertEqual([r.random() for _ in range(3)], [0.6011037519201636, 0.44829055899754167, 0.8524657934904099])

    def test_process_time_mean(self):
        r = Rng(7)
        xs = [r.process(0.2, 0.75) for _ in range(20000)]
        self.assertAlmostEqual(sum(xs) / len(xs), 0.2, delta=0.004)
        self.assertEqual(r.process(0.2, 0.0), 0.2)


class RevenueTest(unittest.TestCase):
    def test_contract_pricing(self):
        c3 = (1250.0, 0.5, 1.0)
        self.assertEqual(revenue_for(c3, 0.5), 1250)
        self.assertEqual(revenue_for(c3, 0.75), 625)
        self.assertEqual(revenue_for(c3, 1.0), 0)
        self.assertEqual(revenue_for((750.0, 7.0, 14.0), 4.0), 750)


def quiet(**kw):
    """Constant process times, no demand: only what the test sets up happens."""
    return Config(cv=(0.0, 0.0, 0.0), game_end=kw.pop('game_end', 5), **kw)


class KitOrderRules(unittest.TestCase):
    """The four Littlefield conditions, one at a time."""

    def run_one(self, **start):
        st = StartState(**{'day': 0, 'cash': 1e6, 'kits': 600, 'rop': 1000, 'qty': 1200, **start})
        return simulate(quiet(), Policy(), st, demand=0)

    def test_orders_when_all_four_hold(self):
        self.assertEqual(len(self.run_one()['orders']), 1)

    def test_not_while_inventory_above_reorder_point(self):
        self.assertEqual(self.run_one(kits=1200)['orders'], [])

    def test_not_while_an_order_is_on_the_way(self):
        r = self.run_one(order_arrives=10.0, order_qty=1200)
        self.assertEqual(r['orders'], [])

    def test_not_without_enough_cash(self):
        self.assertEqual(self.run_one(cash=12_000)['orders'], [])   # one order costs $13,000
        self.assertEqual(len(self.run_one(cash=13_000)['orders']), 1)

    def test_not_with_zero_quantity(self):
        self.assertEqual(self.run_one(qty=0)['orders'], [])

    def test_order_arrives_after_lead_time_and_frees_waiting_jobs(self):
        st = StartState(day=0, cash=1e6, kits=0, rop=0, qty=600, jobs=[(0.0, 1, 'kits')])
        r = simulate(quiet(game_end=8), Policy(), st, demand=0)
        self.assertAlmostEqual(r['orders'][0][0], 0.0)
        self.assertEqual(r['wip_left'], 0)
        lead = sum(Config().visit_time(s) for s in range(4)) + 4.0
        self.assertAlmostEqual(r['days'][4]['leads'][0], lead, places=6)


class FactoryRules(unittest.TestCase):
    def test_single_job_takes_the_pure_processing_time(self):
        st = StartState(day=0, kits=60, rop=0, qty=0, jobs=[(0.0, 3, 0)])
        r = simulate(quiet(), Policy(), st, demand=0)
        self.assertAlmostEqual(r['days'][0]['leads'][0], sum(Config().ptimes), places=9)
        self.assertEqual(r['days'][0]['revenue'], 1250)

    def test_wip_limit_turns_orders_away(self):
        st = StartState(day=0, machines=(1, 1, 1), kits=10 ** 6, rop=0, qty=0)
        r = simulate(quiet(game_end=10), Policy(), st, demand=60)
        self.assertGreater(sum(d['rejected'] for d in r['days']), 0)
        self.assertLessEqual(max(d['wip'] for d in r['days']), 100)

    def test_machine_purchase_needs_cash(self):
        st = StartState(day=0, cash=50_000, rop=0, qty=0)
        r = simulate(quiet(), Policy(machines={1: (3, 3, 2)}), st, demand=0)
        self.assertEqual(r['purchases'], [])
        self.assertTrue(r['blocked'])

    def test_no_changes_after_control_ends(self):
        st = StartState(day=0, rop=0, qty=0)
        r = simulate(quiet(control_end=2, game_end=6), Policy(contract={4: 3}), st, demand=0)
        self.assertEqual(r['days'][-1]['contract'], 1)

    def test_priority_rule_serves_step_4_first(self):
        # One Station 2 machine, an older job queued for step 2 and a newer one for step 4.
        jobs = [(-1.0, 1, 1), (-0.5, 1, 3)]
        v = Config().visit_time
        first = lambda rule: simulate(quiet(), Policy(), StartState(
            day=0, machines=(1, 1, 1), kits=0, rop=0, qty=0, schedule=rule, jobs=jobs), demand=0)['days'][0]['leads'][0]
        self.assertAlmostEqual(first(PRIORITY_STEP4), 0.5 + v(3), places=9)
        self.assertAlmostEqual(first(FIFO), 0.5 + v(1) + v(3), places=9)

    def test_final_order_sets_quantity_to_zero_after_it_fires(self):
        st = StartState(day=0, cash=1e7, kits=6000, rop=0, qty=0)
        r = simulate(quiet(game_end=20), Policy(final_day=3, final_qty=6000), st, demand=10)
        self.assertEqual([q for _, q in r['orders']], [6000])


class AgainstTheRealGame(unittest.TestCase):
    """Days 1-50 of Simulation 2, replayed with the real daily order counts."""

    @classmethod
    def setUpClass(cls):
        cls.cfg = S.config(DAY50)
        real, runs = C.replay(DAY50, cls.cfg, runs=20)
        cls.rows, cls.s = C.compare(real, runs)

    def test_measured_process_times(self):
        self.assertEqual(S.measured_ptimes(DAY50), (0.1171, 0.1749, 0.1226))

    def test_kit_orders_on_the_real_days(self):
        for days in self.s['order_days_each']:
            self.assertEqual(days, [9, 16, 25, 32, 41, 48])

    def test_lead_time(self):
        # Variability is fitted on the quiet post-restart days (61-198), where every remaining
        # decision falls; the congested Days 1-50 are reproduced a little less closely.
        self.assertLess(abs(self.s['lead_bias']), 0.3)
        self.assertLess(self.s['lead_rmse'], 0.55)

    def test_queues_and_utilization(self):
        for k in range(3):
            self.assertLess(abs(self.s['queue_real'][k] - self.s['queue_sim'][k]), 1.0 + 0.3 * self.s['queue_real'][k])
            self.assertLess(abs(self.s['util_real'][k] - self.s['util_sim'][k]), 0.03)

    def test_cash_on_day_50_within_one_percent(self):
        self.assertLess(abs(self.s['cash_sim'] / self.s['cash_real'] - 1), 0.01)

    def test_stockouts_start_on_the_real_days(self):
        real = [r['day'] for r in self.rows if r['waiting_real'] > 0.5 and (r['day'] - 1) not in
                {x['day'] for x in self.rows if x['waiting_real'] > 0.5}]
        sim = [r['day'] for r in self.rows if r['waiting_sim'] > 0.5 and (r['day'] - 1) not in
               {x['day'] for x in self.rows if x['waiting_sim'] > 0.5}]
        self.assertEqual(real, [11, 18, 27, 34, 43, 50])
        self.assertEqual(len(sim), len(real))
        for a, b in zip(sim, real):  # same wave, within a day
            self.assertLessEqual(abs(a - b), 1)


class ReplayWithChanges(unittest.TestCase):
    """The synthetic Day 59 file has machine purchases, a big kit order and two contract switches."""

    def test_follows_the_teams_actual_changes(self):
        snap = S.load(os.path.join(FIXTURES, 'day59-synthetic.json'))
        real, runs = C.replay(snap, S.config(snap), runs=10)
        pol = C.history_policy(real)
        self.assertEqual(pol.machines[51], (3, 4, 3))
        self.assertEqual(pol.contract, {1: 1, 55: 2, 57: 3})
        _, s = C.compare(real, runs)
        for days in s['order_days_each']:
            self.assertEqual(days, s['order_days_real'])
        self.assertLess(abs(s['cash_sim'] / s['cash_real'] - 1), 0.05)


class AfterTheRestart(unittest.TestCase):
    """Day 64 snapshot: machines bought on Day 51, $1,000 contract from Day 56, $1,250 from Day 61."""

    @classmethod
    def setUpClass(cls):
        cls.snap = S.load(os.path.join(FIXTURES, 'day64.json'))
        cls.real, cls.runs = C.replay(cls.snap, S.config(cls.snap), runs=30)

    def test_replay_follows_the_restart_moves(self):
        pol = C.history_policy(self.real)
        self.assertEqual(pol.machines, {1: (2, 3, 2), 51: (3, 4, 3)})
        self.assertEqual(pol.contract, {1: 1, 56: 2, 61: 3})

    def test_revenue_per_job_on_the_1250_contract(self):
        idx = [i for i, d in enumerate(self.real) if d['day'] >= 61]
        real = sum(self.real[i]['revenue'] for i in idx) / sum(self.real[i]['completed'] for i in idx)
        rev = sum(r['days'][i]['revenue'] for r in self.runs for i in idx)
        done = sum(r['days'][i]['completed'] for r in self.runs for i in idx)
        self.assertLess(abs(rev / done - real), 75)   # real $1,163 a job over Days 61-64

    def test_cash_on_day_64(self):
        cash = sum(r['final_cash'] for r in self.runs) / len(self.runs)
        self.assertLess(abs(cash / self.real[-1]['cash'] - 1), 0.01)

    def test_start_state(self):
        st = S.start_state(self.snap)
        self.assertEqual((st.day, st.machines, st.kits, st.contract, st.schedule), (64, (3, 4, 3), 21540, 3, PRIORITY_STEP4))
        self.assertIsNone(st.order_arrives)


class OnTheTwelveHundredFiftyContract(unittest.TestCase):
    """Day 78 download: 18 days on the $1,250 contract at 3/4/3. Revenue per job depends on the
    spread of lead times, which is where the Days 1-50 calibration drifted ($1,119 against $1,162)."""

    @classmethod
    def setUpClass(cls):
        snap = S.load(os.path.join(FIXTURES, 'day78.json'))
        cls.real, cls.runs = C.replay(snap, S.config(snap), runs=30)
        cls.c3 = C.contract_period(cls.real, cls.runs)

    def test_revenue_per_job_within_25_dollars(self):
        self.assertEqual(self.c3['days'][0], 61)
        self.assertAlmostEqual(self.c3['rev_real'], 1162, delta=1)
        self.assertLess(abs(self.c3['rev_sim'] - self.c3['rev_real']), 25)

    def test_lead_time(self):
        self.assertLess(abs(self.c3['lead_sim'] - self.c3['lead_real']), 0.03)

    def test_past_reorder_points_are_estimated_per_order(self):
        rops = C.order_rops(self.real)
        self.assertEqual(sorted(rops), [9, 16, 25, 32, 41, 48, 52])
        for day in (9, 16, 25, 32, 41, 48):        # the setting was 1,440 then
            self.assertLess(abs(rops[day] - 1440), 400)


class ThroughDay198(unittest.TestCase):
    """138 days on the $1,250 contract (61-198, about 2,000 jobs): the main calibration target."""

    @classmethod
    def setUpClass(cls):
        cls.snap = S.load(os.path.join(FIXTURES, 'day198.json'))
        cls.real, cls.runs = C.replay(cls.snap, S.config(cls.snap), runs=20)
        cls.c3 = C.contract_period(cls.real, cls.runs)

    def test_revenue_per_job_and_lead_time(self):
        self.assertEqual((self.c3['days'][0], self.c3['days'][-1]), (61, 198))
        self.assertAlmostEqual(self.c3['rev_real'], 1142, delta=1)
        self.assertLess(abs(self.c3['rev_sim'] - self.c3['rev_real']), 15)
        self.assertLess(abs(self.c3['lead_sim'] - self.c3['lead_real']), 0.01)

    def test_cash_on_day_198(self):
        cash = sum(r['final_cash'] for r in self.runs) / len(self.runs)
        self.assertLess(abs(cash / self.real[-1]['cash'] - 1), 0.01)

    def test_final_order_from_day_198(self):
        st = S.start_state(self.snap, demand=15.0)
        st.qty = 26100                          # what Littlefield ordered on Days 113, 142 and 173
        cfg = S.config(self.snap)
        a = A.final_order(st, cfg, Policy(), days=[200], demand=15.0, runs=20)[0]
        b = A.final_order(st, cfg, Policy(), days=[210], demand=15.0, runs=20)[0]
        self.assertEqual((a['fires'], b['fires']), (1.0, 1.0))
        self.assertLess(abs(a['size_p50'] - 53340), 600)   # replaces the next automatic order
        self.assertLess(abs(b['size_p50'] - 27240), 600)   # after the automatic 26,100 has arrived
        self.assertLess(abs(a['final_cash_p50'] - b['final_cash_p50']), 10000)


class StartingFromASnapshot(unittest.TestCase):
    def test_day50_state(self):
        st = S.start_state(DAY50)
        self.assertEqual((st.day, st.cash, st.machines, st.kits), (50, 1106279.0, (2, 3, 2), 0))
        self.assertEqual(len(st.jobs), 68)
        self.assertEqual(sum(1 for j in st.jobs if j[2] == 'kits'), 15)
        self.assertEqual((st.order_qty, st.order_arrives), (7200, 51.5))

    def test_presets_rank_as_expected(self):
        st = S.start_state(DAY50)
        cfg = S.config(DAY50)
        p = {k: A.project(st, cfg, pol, runs=10)['final_p50'] for k, pol in A.presets(st, cfg, final_day=210).items()}
        nothing, safe, rec = p.values()
        self.assertLess(nothing, safe)
        self.assertLess(safe, rec)


class Textbook(unittest.TestCase):
    def test_erlang_c(self):
        # M/M/1 with lam=1, mu=2: Wq = rho / (mu - lam) = 0.5
        self.assertAlmostEqual(A.erlang_c_wait(1, 2, 1), 0.5)
        self.assertIsNone(A.erlang_c_wait(3, 1, 2))


if __name__ == '__main__':
    unittest.main()

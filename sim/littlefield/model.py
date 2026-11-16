"""Event simulation of the Littlefield factory.

Time is in days. Day d is the interval (d-1, d]; its numbers are booked at time d,
the same way the Littlefield download reports them.

Routing of a job (one job = 60 kits): Station 1 -> Station 2 (step 2) -> Station 3
-> Station 2 (step 4) -> done. Station 2 serves both steps from one queue, ordered by
the scheduling rule (FIFO, prioritize step 2, prioritize step 4).

Kits are ordered automatically when all four Littlefield conditions hold:
  1. kits on hand <= reorder point
  2. no kit order is on the way
  3. cash on hand >= cost of one order (kits x price + fee)
  4. order quantity > 0
If cash is short, no order is made; the check repeats whenever any condition can change.
"""
from dataclasses import dataclass, field
import heapq

from .rng import Rng

FIFO, PRIORITY_STEP2, PRIORITY_STEP4 = 'FIFO', 'Prioritize Step 2', 'Prioritize Step 4'
SCHEDULES = (FIFO, PRIORITY_STEP2, PRIORITY_STEP4)

# Job steps: index into the route. Station number for each step.
ROUTE = (0, 1, 2, 1)  # step 1 St1, step 2 St2, step 3 St3, step 4 St2


@dataclass
class Config:
    """Game constants. Defaults are the Settings tab values for Simulation 2."""
    kits_per_job: int = 60
    kit_cost: float = 10.0
    order_fee: float = 1000.0
    kit_lead: float = 4.0
    daily_rate: float = 1.1 ** (1 / 365) - 1
    wip_limit: int = 100
    control_end: int = 218
    game_end: int = 268
    resale: float = 10000.0
    prices: tuple = (90000.0, 80000.0, 100000.0)
    # Machine-days per job at each station. Station 2's figure covers both visits.
    # Measured from Days 1-50 utilization (snapshot.measured_ptimes); the Settings tab's
    # planning values are 0.117 / 0.175 / 0.128.
    ptimes: tuple = (0.1171, 0.1749, 0.1226)
    # Share of Station 2's time spent on step 2 (the rest is step 4). The Day 1-50 data
    # cannot tell 0.3 from 0.7 apart; 0.5 is used.
    step2_share: float = 0.5
    # Variability of process times at each station (coefficient of variation,
    # 0 = constant, 1 = exponential). Fitted on Days 1-50 by calibrate.fit:
    # Station 1 nearly constant, Station 2 fairly variable, Station 3 fully random.
    cv: tuple = (0.0, 0.75, 1.0)
    # contract number -> (revenue, quoted lead time, maximum lead time)
    contracts: dict = field(default_factory=lambda: {1: (750.0, 7.0, 14.0), 2: (1000.0, 1.0, 3.0), 3: (1250.0, 0.5, 1.0)})

    def visit_time(self, step):
        st = ROUTE[step]
        if st == 1:
            return self.ptimes[1] * (self.step2_share if step == 1 else 1 - self.step2_share)
        return self.ptimes[st]

    @classmethod
    def from_settings(cls, s, **overrides):
        """Build from the snapshot's settings object (the Sheet's Settings tab)."""
        def pick(key, default):
            v = s.get(key)
            return v if isinstance(v, (int, float)) and v != 0 else default
        base = cls()
        kw = dict(
            kits_per_job=int(pick('kitsPerJob', base.kits_per_job)), kit_cost=pick('kitCost', base.kit_cost),
            order_fee=pick('orderFee', base.order_fee), kit_lead=pick('kitLead', base.kit_lead),
            daily_rate=pick('dailyRate', base.daily_rate), wip_limit=int(pick('wipLimit', base.wip_limit)),
            control_end=int(pick('controlEnd', base.control_end)), game_end=int(pick('gameEnd', base.game_end)),
            resale=pick('resale', base.resale),
        )
        st = s.get('stations') or []
        if len(st) == 3 and all(x.get('price') for x in st):
            kw['prices'] = tuple(float(x['price']) for x in st)
        if len(st) == 3 and all(x.get('ptime') for x in st):
            kw['ptimes'] = tuple(float(x['ptime']) for x in st)
        cs = s.get('contracts') or []
        if len(cs) == 3 and all(c.get('revenue') for c in cs):
            kw['contracts'] = {k + 1: (float(c['revenue']), float(c['quoted']), float(c['max'])) for k, c in enumerate(cs)}
        kw.update(overrides)
        return cls(**kw)


def revenue_for(contract, lead_time):
    """Revenue for one job: full up to the quoted time, falling linearly to 0 at the maximum."""
    rev, quoted, maximum = contract
    if lead_time <= quoted:
        return rev
    if lead_time >= maximum:
        return 0.0
    return rev * (maximum - lead_time) / (maximum - quoted)


@dataclass
class Policy:
    """The team's settings over time. Each dict maps a day to the value from the start of that day.

    Changes take effect at the start of the given day and are ignored after control ends.
    """
    machines: dict = field(default_factory=dict)      # day -> (m1, m2, m3)
    contract: dict = field(default_factory=dict)      # day -> 1, 2 or 3
    rop: dict = field(default_factory=dict)           # day -> reorder point (kits)
    qty: dict = field(default_factory=dict)           # day -> order quantity (kits)
    schedule: dict = field(default_factory=dict)      # day -> rule
    # Auto-ladder: each day, step to a better contract when the expected revenue of a
    # new order beats the current one with this lead-time margin (see _ladder).
    ladder: bool = False
    ladder_top: int = 3
    ladder_margin: float = 0.25
    # Final kit order: on this day, order this many kits (None = computed in the run),
    # by raising the reorder point; the quantity is set to 0 as soon as it is placed.
    final_day: int = None
    final_qty: int = None
    # Replay only: kit orders known to have been placed, day -> kits. Placed on that day
    # at the first moment kits on hand are at or below `placed_rop` (the reorder rule's
    # trigger), or at the end of the day if that never happens. Cash is still charged.
    placed_orders: dict = field(default_factory=dict)
    placed_rop: int = 0


@dataclass
class StartState:
    """Factory state at time `day` (end of that day)."""
    day: int = 0
    cash: float = 1_000_000.0
    machines: tuple = (2, 3, 2)
    kits: int = 9600                  # on hand
    order_arrives: float = None       # time the kit order on the way arrives
    order_qty: int = 0
    contract: int = 1
    rop: int = 1440
    qty: int = 7200
    schedule: str = FIFO
    # Jobs already in the factory: list of (accepted_time, contract, where) with
    # where = 'kits' (waiting for kits) or a step index 0..3 (queued for that step).
    jobs: list = field(default_factory=list)


class _Job:
    __slots__ = ('accepted', 'contract', 'step', 'queued')

    def __init__(self, accepted, contract):
        self.accepted = accepted
        self.contract = contract
        self.step = 0
        self.queued = 0.0


# Event kinds, ordered so simultaneous events resolve the same way every time.
_DAY, _KITS, _FINISH, _ARRIVAL, _PLACE = 0, 1, 2, 3, 4


class _Sim:
    def __init__(self, cfg, policy, start, rng, demand, arrivals):
        self.cfg, self.pol, self.rng = cfg, policy, rng
        self.demand = demand            # jobs/day, number or function(day) -> rate
        self.arrivals = arrivals        # optional list of exact arrival times (replay)
        self.t = float(start.day)
        self.cash = start.cash
        self.prev_close = start.cash
        self.machines = list(start.machines)
        self.busy = [0, 0, 0]
        self.queue = [[], [], []]
        self.kits = start.kits
        self.in_transit = start.order_arrives is not None
        self.contract = start.contract
        self.rop, self.qty, self.schedule = start.rop, start.qty, start.schedule
        self.final_pending = False
        self.forced = None              # replay: (day, kits) of a known order not yet placed
        self.waiting = []               # jobs waiting for kits, FIFO
        self.wip = 0
        self.events = []
        self.seq = 0
        self.orders = []                # (time, kits)
        self.purchases = []             # (day, station, +n/-n)
        self.blocked = []               # (day, what)
        self.days = []
        self._reset_day()
        self.last = self.t
        if self.in_transit:
            self._push(start.order_arrives, _KITS, start.order_qty)
        for accepted, contract, where in sorted(start.jobs, key=lambda j: j[0]):
            job = _Job(accepted, contract)
            self.wip += 1
            if where == 'kits':
                self.waiting.append(job)
            else:
                job.step = where
                self._enqueue(job)
        for s in range(3):
            self._dispatch(s)
        if start.day < cfg.control_end:  # settings for the first simulated day
            self._apply_policy(start.day + 1)
        if self.arrivals is None:
            self._next_arrival()
        else:
            for a in self.arrivals:
                if a > self.t:
                    self._push(a, _ARRIVAL, None)
        self._push(float(start.day + 1), _DAY, start.day + 1)
        for day, kits in policy.placed_orders.items():
            if day - 1 >= self.t:
                self._push(day - 1.0 + 1e-6, _PLACE, (day, kits, 'open'))
                self._push(day - 1e-6, _PLACE, (day, kits, 'close'))

    # ------------------------------------------------------------ helpers
    def _push(self, t, kind, data):
        self.seq += 1
        heapq.heappush(self.events, (t, kind, self.seq, data))

    def _rate(self, day):
        return self.demand(day) if callable(self.demand) else self.demand

    def _next_arrival(self):
        day = int(self.t) + 1
        rate = self._rate(day)
        if rate > 0:
            self._push(self.t + self.rng.exponential(rate), _ARRIVAL, None)
        else:  # no demand today: look again tomorrow
            self._push(float(day), _ARRIVAL, 'skip')

    def _reset_day(self):
        self.d_acc = self.d_rej = self.d_done = 0
        self.d_rev = self.d_lead = 0.0
        self.d_wait = 0.0
        self.d_q = [0.0, 0.0, 0.0]
        self.d_busy = [0.0, 0.0, 0.0]
        self.d_mach = [0.0, 0.0, 0.0]
        self.d_leads = []

    def _advance(self, t):
        dt = t - self.last
        if dt > 0:
            self.d_wait += dt * len(self.waiting)
            for s in range(3):
                self.d_q[s] += dt * len(self.queue[s])
                self.d_busy[s] += dt * min(self.busy[s], self.machines[s])
                self.d_mach[s] += dt * self.machines[s]
        self.last = t
        self.t = t

    def _enqueue(self, job):
        job.queued = self.t
        self.queue[ROUTE[job.step]].append(job)

    def _pick(self, s):
        q = self.queue[s]
        if s == 1 and self.schedule != FIFO:
            want = 1 if self.schedule == PRIORITY_STEP2 else 3
            for i, job in enumerate(q):
                if job.step == want:
                    return q.pop(i)
        return q.pop(0)

    def _dispatch(self, s):
        while self.busy[s] < self.machines[s] and self.queue[s]:
            job = self._pick(s)
            self.busy[s] += 1
            self._push(self.t + self.rng.process(self.cfg.visit_time(job.step), self.cfg.cv[s]), _FINISH, (s, job))

    def _order_cost(self, qty):
        return qty * self.cfg.kit_cost + self.cfg.order_fee

    def _place(self, kits):
        self.cash -= self._order_cost(kits)
        self.in_transit = True
        self.orders.append((self.t, kits))
        self._push(self.t + self.cfg.kit_lead, _KITS, kits)

    def _check_forced(self):
        if self.forced and self.kits <= self.pol.placed_rop:
            self._place(self.forced[1])
            self.forced = None

    def _check_order(self):
        if self.forced is not None:
            self._check_forced()
        if self.in_transit or self.qty <= 0 or self.kits > self.rop:
            return
        cost = self._order_cost(self.qty)
        if self.cash < cost:
            return
        self.cash -= cost
        self.in_transit = True
        self.orders.append((self.t, self.qty))
        self._push(self.t + self.cfg.kit_lead, _KITS, self.qty)
        if self.final_pending:  # the final order went through: the team sets the quantity to 0,
            self.final_pending = False  # but only while it still has control
            if self.t < self.cfg.control_end:
                self.qty = 0

    def _start_job(self, job):
        self.kits -= self.cfg.kits_per_job
        self._enqueue(job)
        self._dispatch(0)

    # ------------------------------------------------------------ events
    def _on_arrival(self, data):
        if data != 'skip':
            if self.wip >= self.cfg.wip_limit:
                self.d_rej += 1
            else:
                self.wip += 1
                self.d_acc += 1
                job = _Job(self.t, self.contract)
                if self.kits >= self.cfg.kits_per_job and not self.waiting:
                    self._start_job(job)
                else:
                    self.waiting.append(job)
                self._check_order()
        if self.arrivals is None:
            self._next_arrival()

    def _on_kits(self, qty):
        self.kits += qty
        self.in_transit = False
        while self.waiting and self.kits >= self.cfg.kits_per_job:
            self._start_job(self.waiting.pop(0))
        self._check_order()

    def _on_finish(self, data):
        s, job = data
        self.busy[s] -= 1
        job.step += 1
        if job.step < len(ROUTE):
            self._enqueue(job)
            self._dispatch(ROUTE[job.step])
        else:
            self.wip -= 1
            lead = self.t - job.accepted
            rev = revenue_for(self.cfg.contracts[job.contract], lead)
            self.cash += rev
            self.d_done += 1
            self.d_rev += rev
            self.d_lead += lead
            self.d_leads.append(lead)
            self._check_order()
        self._dispatch(s)

    def _on_day(self, day):
        # Book day `day`, then apply the settings for day+1.
        self.cash += self.prev_close * self.cfg.daily_rate
        self.prev_close = self.cash
        self.days.append({
            'day': day, 'accepted': self.d_acc, 'rejected': self.d_rej, 'completed': self.d_done,
            'revenue': self.d_rev, 'lead': self.d_lead / self.d_done if self.d_done else None,
            'leads': self.d_leads,
            'waiting': self.d_wait, 'queue': [q for q in self.d_q],
            'util': [self.d_busy[s] / self.d_mach[s] if self.d_mach[s] else 0.0 for s in range(3)],
            'machines': tuple(self.machines), 'cash': self.cash, 'kits': self.kits,
            'wip': self.wip, 'contract': self.contract,
        })
        self._reset_day()
        nxt = day + 1
        if nxt > self.cfg.game_end:
            return False
        if day < self.cfg.control_end:  # the team can still change settings for day `nxt`
            self._apply_policy(nxt)
        self._push(float(nxt), _DAY, nxt)
        return True

    def _apply_policy(self, day):
        p = self.pol
        if day in p.machines:
            for s, want in enumerate(p.machines[day]):
                while self.machines[s] < want:
                    price = self.cfg.prices[s]
                    if self.cash < price:
                        self.blocked.append((day, 'machine at Station %d' % (s + 1)))
                        break
                    self.cash -= price
                    self.machines[s] += 1
                    self.purchases.append((day, s + 1, +1))
                while self.machines[s] > max(want, 1):
                    self.cash += self.cfg.resale
                    self.machines[s] -= 1
                    self.purchases.append((day, s + 1, -1))
                self._dispatch(s)
        if day in p.contract:
            self.contract = p.contract[day]
        if day in p.rop:
            self.rop = p.rop[day]
        if day in p.qty:
            self.qty = p.qty[day]
        if day in p.schedule:
            self.schedule = p.schedule[day]
        if p.ladder:
            self._ladder()
        if p.final_day == day:
            size = p.final_qty if p.final_qty is not None else self.final_order_size(day)
            if size > 0:
                self.qty = size
                self.rop = 10 ** 9
                self.final_pending = True
            else:
                self.qty = 0
        self._check_order()

    # ------------------------------------------------------------ decisions made inside a run
    def lead_estimate(self):
        """Expected lead time of an order accepted now, from the work ahead of it."""
        cfg = self.cfg
        work = [0.0, 0.0, 0.0]
        for s in range(3):
            for job in self.queue[s]:
                work[s] += cfg.visit_time(job.step)
        # Jobs waiting for kits and the new one need every step.
        ahead = len(self.waiting)
        for step in range(len(ROUTE)):
            work[ROUTE[step]] += ahead * cfg.visit_time(step)
        wait = sum(work[s] / max(self.machines[s], 1) for s in range(3))
        kit_wait = 0.0
        need = (len(self.waiting) + 1) * cfg.kits_per_job
        if self.kits < need:
            kit_wait = (self._kits_due() - self.t) if self.in_transit else cfg.kit_lead
        pure = sum(cfg.visit_time(step) for step in range(len(ROUTE)))
        return max(wait, kit_wait) + pure

    def _kits_due(self):
        due = [t for t, kind, _, _ in self.events if kind == _KITS]
        return min(due) if due else self.t + self.cfg.kit_lead

    def _ladder(self):
        """Step up to the contract with the best expected revenue for a new order.

        The lead-time estimate is stretched by the margin, so the rule waits until
        the switch is safe rather than merely possible.
        """
        if self.contract > self.pol.ladder_top:  # the ladder's ceiling is a cap
            self.contract = self.pol.ladder_top
        lead = self.lead_estimate() * (1 + self.pol.ladder_margin)
        # Only ever step up: a team on the $1,250 contract does not drop back for one busy day.
        best = max(range(self.contract, self.pol.ladder_top + 1), key=lambda c: (revenue_for(self.cfg.contracts[c], lead), -c), default=self.contract)
        self.contract = best

    def final_order_size(self, day):
        """Kits still needed for jobs that can be finished by the end of the game, minus kits we have.

        Jobs accepted in the last `pure processing` time cannot finish, so their kits would be wasted.
        """
        cfg = self.cfg
        pure = sum(cfg.visit_time(step) for step in range(len(ROUTE)))
        horizon = max(0.0, cfg.game_end - pure - self.t)
        jobs_needed = sum(self._rate(d) for d in range(day, cfg.game_end + 1)) * horizon / max(cfg.game_end - self.t, 1e-9)
        have = self.kits - len(self.waiting) * cfg.kits_per_job
        if self.in_transit:
            have += sum(d for _, kind, _, d in self.events if kind == _KITS)
        need = jobs_needed * cfg.kits_per_job - have
        return max(0, int(round(need / cfg.kits_per_job)) * cfg.kits_per_job)

    # ------------------------------------------------------------ run
    def run(self):
        while self.events:
            t, kind, _, data = heapq.heappop(self.events)
            self._advance(t)
            if kind == _DAY:
                if not self._on_day(data):
                    break
            elif kind == _KITS:
                self._on_kits(data)
            elif kind == _FINISH:
                self._on_finish(data)
            elif kind == _PLACE:
                day, kits, edge = data
                if edge == 'open':
                    self.forced = (day, kits)
                    self._check_forced()
                elif self.forced and self.forced[0] == day:
                    self._place(kits)
                    self.forced = None
            else:
                self._on_arrival(data)
        return {
            'days': self.days, 'orders': self.orders, 'purchases': self.purchases, 'blocked': self.blocked,
            'final_cash': self.cash, 'kits_left': self.kits, 'wip_left': self.wip,
        }


def simulate(cfg=None, policy=None, start=None, seed=1, demand=15.5, arrivals=None):
    """Run one simulation from `start` to the end of the game (or to the last replayed arrival).

    demand    jobs per day: a number, or a function day -> rate
    arrivals  exact arrival times instead of random demand (used to replay the real game)
    """
    cfg = cfg or Config()
    policy = policy or Policy()
    start = start or StartState()
    if arrivals is not None:
        cfg = Config(**{**cfg.__dict__, 'game_end': min(cfg.game_end, int(max(arrivals)) + 1)})
    return _Sim(cfg, policy, start, Rng(seed), demand, arrivals).run()

"""Littlefield Simulation 2 event simulation (A Team).

Reference model for the dashboard's what-if simulator. Pure standard library so the
JavaScript port can follow it line by line.
"""
from .model import Config, Policy, StartState, simulate, revenue_for  # noqa: F401

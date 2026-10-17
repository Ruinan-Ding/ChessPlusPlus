"""Fixed numerical inputs for rule examples, separate from the shipped balance."""
import json
from pathlib import Path

from game.engine.config_loader import load_config


BALANCE_CONFIG = json.loads((Path(__file__).resolve().parents[3] / 'shared/testing/balance-config.json').read_text(encoding='utf-8'))


def balance_config():
    # These examples assert hand-calculated outcomes from fixed inputs. Loading a
    # separate saved preset keeps a shipped rebalance from changing those inputs,
    # while still exercising the normal migration and validation boundary.
    return load_config(BALANCE_CONFIG)

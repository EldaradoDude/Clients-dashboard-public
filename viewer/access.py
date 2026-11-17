"""What the logged-in user may see: their grants (users.py), checked on every data request.

Market data (order book, depth, mid) needs a symbol grant for (venue, symbol). Balances and trades
take several accounts and one pair (query.pair_key); each account needs an account grant for
(venue, account) and a symbol grant on its venue for the pair. Anything else is refused with 403,
and /api/options lists only granted values.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import Depends, HTTPException, Query

from auth import CurrentUser
from query import pair_key
from schemas import AccountQuery, MarketQuery


@dataclass(frozen=True)
class Grants:
    accounts: frozenset[tuple[str, str]]  # (venue, account)
    symbols: frozenset[tuple[str, str]]  # (venue, symbol)

    def check_symbol(self, venue: str, symbol: str) -> None:
        if (venue, symbol) not in self.symbols:
            raise HTTPException(403, f"No access to symbol {venue}/{symbol}.")

    def check_account(self, venue: str, account: str) -> None:
        if (venue, account) not in self.accounts:
            raise HTTPException(403, f"No access to account {venue}/{account}.")

    def pair_symbols(self, venue: str, pair: str) -> list[str]:
        """The granted symbols of the venue that are this pair (normally one)."""
        key = pair_key(pair)
        return sorted(s for v, s in self.symbols if v == venue and pair_key(s) == key)

    def filter_options(self, options: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        """The granted part of fetch_filter_values() output. Granted values ClickHouse doesn't
        list (granted with --force) are kept, so they can still be picked."""
        venues = sorted({v for v, _ in self.accounts} | {v for v, _ in self.symbols})
        result = {}
        for venue in venues:
            known = options.get(venue, {"symbols": [], "accounts": {}})
            symbols = sorted(s for v, s in self.symbols if v == venue)
            result[venue] = {
                "symbols": symbols,
                "accounts": {
                    account: [s for s in known["accounts"].get(account, []) if s in symbols]
                    for account in sorted(a for v, a in self.accounts if v == venue)
                },
            }
        return result


def user_grants(user: CurrentUser) -> Grants:
    return Grants(
        accounts=frozenset((g.venue, g.account) for g in user.accounts),
        symbols=frozenset((g.venue, g.symbol) for g in user.symbols),
    )


UserGrants = Annotated[Grants, Depends(user_grants)]


def granted_market(q: Annotated[MarketQuery, Query()], grants: UserGrants) -> MarketQuery:
    grants.check_symbol(q.venue, q.symbol)
    return q


@dataclass(frozen=True)
class AccountSelection:
    """Checked accounts and the period of a balance or trades request."""
    accounts: list[tuple[str, str]]  # (venue, account), in request order
    account_symbols: list[tuple[str, str, str]]  # (venue, account, venue symbol of the pair)
    start: int
    end: int


def granted_accounts(q: Annotated[AccountQuery, Query()], grants: UserGrants) -> AccountSelection:
    account_symbols = []
    for venue, account in q.accounts:
        grants.check_account(venue, account)
        symbols = grants.pair_symbols(venue, q.symbol)
        if not symbols:
            raise HTTPException(403, f"No access to symbol {q.symbol} on {venue}.")
        account_symbols += [(venue, account, symbol) for symbol in symbols]
    return AccountSelection(q.accounts, account_symbols, q.start, q.end)


# Query parameters of the data endpoints, validated and checked against the user's grants.
Market = Annotated[MarketQuery, Depends(granted_market)]
Accounts = Annotated[AccountSelection, Depends(granted_accounts)]

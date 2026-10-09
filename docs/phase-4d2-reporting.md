# Phase 4D-2 donation and reporting contracts

`GET /api/v1/donations` returns only records whose `user` equals the authenticated donor ID. Email is never an ownership key, and guest status grants remain limited to the payment-status flow. Lists are bounded to 100 records per page with stable `createdAt`, `_id` ordering.

Admin donation list/detail endpoints return donor contact details, safe provider references, payment lifecycle, and verified adjustments. They never return status-token hashes, webhook bodies, credentials, or provider payloads. Only offline pending donations can be manually completed or rejected.

`GET /api/v1/admin/reports/financial` is admin-only. Dates are ISO timestamps interpreted in UTC. Aggregation runs in MongoDB and returns confirmed base donations, fee contributions, gross charges, known provider fees, financial losses, known net proceeds, pending base amounts, and provider/designation breakdowns.

Confirmed records have donation status `completed`. New online records reach that state only through a succeeded provider attempt. Pending ACH is excluded. Successful refunds, ACH returns, and disputes are outflows; successful reversals offset prior outflows, floored at zero to avoid negative loss. Net is reported only when gross charge and actual provider fee are known. Missing fees are counted as unknown and never coerced to zero.

Provider-verified online, legacy PayPal, legacy bank transfer, and admin offline records remain separate. No provider identity, fee, or reference is fabricated for historical data. Accurate payment lifecycle and adjustments depend on verified webhooks and reconciliation. Real provider sandbox and browser QA remain deployment checks.

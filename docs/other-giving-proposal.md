# Proposed Other Giving record (no Atlas write performed)

Target: development Atlas database `pushtidham_payment_sandbox`, collection `givings`.

| Field | Proposed value |
| --- | --- |
| title | Other |
| slug | other |
| categoryId | `ObjectId("34182ed239cb95df622288cc")` (General Donation) |
| category | general |
| festivalGroup | empty string |
| description | empty string |
| image | empty string |
| amountType | custom |
| fixedAmountsCents | empty array |
| status | active |
| displayOrder | 21 |

Before any approved insert, recheck the Atlas host, database, category ID/slug/status, and all Giving documents with either slug `other` or title `Other` (case-insensitive), including inactive or deleted records. If a matching record is identical, skip it. If any match differs, abort for review. In a transaction, repeat these checks and insert only when absent. The unique Giving slug index is the final duplicate guard. Do not update any existing Giving, category, Donation, Event, or User document.

Category management permission is the server-owned `User.canManageGivingCategories` Boolean. It defaults to false and is never accepted by public registration or profile APIs. A separately authorized operator must explicitly grant it to a named admin account through a controlled database operation; no existing admin is automatically granted access.

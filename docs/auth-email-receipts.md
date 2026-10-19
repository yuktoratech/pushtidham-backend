# Authentication, mail, receipts, and exports

## Transactional mail

The backend uses an optional server-side SMTP adapter (Nodemailer) for the contact form and password-reset links. Configure these values only in the backend environment; never expose them through a frontend `NEXT_PUBLIC_*` variable:

```dotenv
MAIL_PROVIDER=smtp
SMTP_HOST=
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
SMTP_PASSWORD=
MAIL_FROM=
CONTACT_TO=
```

Use port `465` with `SMTP_SECURE=true` for implicit TLS, or port `587` with `SMTP_SECURE=false` for mandatory STARTTLS. TLS certificates are verified. `MAIL_FROM` is the fixed sender address and should be authorized by the SMTP account; `CONTACT_TO` is the temple mailbox that receives contact-form messages. Use an SMTP password or provider-issued app password, not a normal account password when the provider supports app passwords. When these values are absent, mail endpoints return a safe unavailable response and the frontend offers the temple email handoff. SMTP acceptance is reported as queued; it is not represented as delivery.

The SMTP host and sender are read only from server configuration. Visitor addresses are used only as `Reply-To`. Connection, greeting, and socket timeouts are bounded, and file/URL access from email content is disabled.

Password-reset links use the configured frontend origin and an expiring, one-time server-side token. The backend stores only a hash of that token. Contact messages are validated, origin checked, rate limited, and sent with the visitor email as a reply-to address.

## Donor accounts

Authenticated donors may update their name, email, and phone number. Roles and account ownership cannot be changed through the profile endpoint. Password changes require the current password and revoke existing sessions after a successful change. New, changed, and reset passwords require 8 to 72 characters and must fit bcrypt's 72-byte limit; legacy accounts can continue to sign in.

## Receipts and CSV reports

Receipt PDFs are generated only from authoritative completed donations. A donor can request only their own receipt; administrators require the existing admin authorization. An offline receipt additionally requires verified offline status. Pending, rejected, disputed, refunded, or unverified payments do not receive a completed-payment receipt.

The admin CSV export applies the authorized server-side filters for date, status, category, and provider. It formats dates in `America/New_York`, uses USD values from integer cents, caps output at 10,000 rows, and prefixes spreadsheet-formula-like values to prevent CSV formula injection. No payment processor identifiers are fabricated or included as proof of payment.

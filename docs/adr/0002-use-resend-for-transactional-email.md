# Use Resend for Transactional Email

SDP **Transactional Email** will consume Resend directly rather than expose a generic email-provider registry. Resend-specific delivery, errors, configuration, and message IDs should stay inside the **Transactional Email** module so future email delivery changes remain local, but SDP should not build unused provider adapters before a second provider is needed.

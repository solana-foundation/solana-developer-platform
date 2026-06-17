# Clerk Owns Organization Invitation Delivery

Organization member invitation email delivery is owned by Clerk, not by SDP **Transactional Email**. SDP may keep local invitation records for role mapping, auditing, development tokens, and membership reconciliation, but it should not route Clerk organization invitations through SDP-owned email delivery. SDP **Transactional Email** is reserved for SDP-owned product workflows such as future **Payment Request** delivery.

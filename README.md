# Clawora Commerce

A custom, platform-independent e-commerce stack for **Clawora Beauty**. The storefront, admin dashboard, API, database schema and media storage code live in this repository. It is designed for Cloudflare Workers + D1 + R2 so the project can start on free tiers and accept a custom domain later.

## Included now

- Premium responsive storefront (Home, Shop, Product, Cart, Checkout, Account)
- COD checkout with server-side price/stock validation
- Customer register/login sessions
- Wishlist and review submission
- Private `/admin` dashboard
- Product CRUD + product image uploads
- Orders, customers, reviews, coupons and store settings
- D1 migrations for products, users, sessions, orders, coupons, reviews, wishlist and settings
- R2 media delivery through `/media/*`
- Dynamic `/sitemap.xml`
- GitHub Actions CI and manual Cloudflare deploy workflow
- Domain-independent configuration

## First Cloudflare setup (later)

1. Create a free Cloudflare account.
2. Create an API token that can deploy Workers and manage D1/R2 for this account.
3. In GitHub repository Settings → Secrets and variables → Actions, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Create a strong Worker secret named `SETUP_KEY` with `npx wrangler secret put SETUP_KEY`.
5. Deploy with `npm install` and `npm run deploy`, then run `npm run db:remote` to apply migrations.
6. Open `/admin` and use the one-time bootstrap form with the same setup key plus your admin email/password.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

## Custom domain later

No domain is hard-coded. After purchasing a domain, attach it to the deployed Worker in Cloudflare. Storefront and `/admin` use same-origin `/api/*` URLs, so application code does not need a rewrite.

## Security

- PBKDF2-SHA256 password hashing with unique salts
- HttpOnly + Secure + SameSite=Lax sessions
- Authenticated admin routes and same-origin writes
- Server-side price/stock recalculation at checkout
- Image MIME/size validation for R2 uploads
- Secrets excluded from source control

## Current milestone

**Milestone 1: working commerce core.** Follow-up milestones: product variants, richer category/brand management, courier integrations, transactional email, anti-bot/rate limiting, analytics, import/export, policy editor, advanced search and production QA.
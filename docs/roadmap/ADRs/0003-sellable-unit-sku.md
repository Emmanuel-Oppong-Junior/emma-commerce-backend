# ADR-0003 — The SKU is the sellable unit

Status: **Accepted** (Emmanuel, 2026-11-18) · Date: 2026-11-16

## Context
Today price and stock live on both `Product` (`price`, `currentPrice`, `basePrice`, `quantity`) and `Variant` (`price`, `quantity`). Cart, order and inventory deduction only use `Product` (VAR-01, ORD-06, INV-01). The two counters are never reconciled (VAR-02). Variants cannot be bought.

## Options
1. Keep the dual model and teach cart/order/inventory about optional variants. This means two code paths everywhere and keeps the reconciliation problem.
2. **Every purchasable item is a `Sku`** (rename/evolve `Variant`). A product without options has exactly one default SKU. Price, cost, stock, barcode, weight, images override and option values live on the SKU. `Product` holds only descriptive/catalogue data.

## Recommendation
**Option 2.** Cart lines, order lines, reservations, stock levels, lots/serials, price lists and promotions all reference `skuId`. `Product.price/quantity` become derived read models (min price, total stock) for listing pages, or are removed.

## Consequences
- Migration: create one default SKU per existing product (copy price, basePrice, quantity, sku, barcode). Existing variants become SKUs. Then point `CartItem`/`OrderItem`/`InventoryLog` at `skuId` (expand/contract, see ROADMAP migration strategy).
- Catalogue queries need "product with its SKUs" loaders (already a DataLoader pattern in `products/loaders`).

## Reversibility
Expensive once order history references SKUs. This is the right default for every vertical, so reversal is unlikely to be needed.

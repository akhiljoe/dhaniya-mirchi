-- Orders are deduplicated per CONNECTION, not per vendor (design §7.10).
-- Deduplicating globally by the vendor's order id meant a second connection
-- to the same grocery account — another household sharing it, or the same
-- person signed in under a new account — found every order "already stored"
-- (under someone else's household), imported nothing, and stopped at the
-- first page. Each connection keeps its own copy; pack sizes (product data)
-- stay shared in sku_packs.
alter table raw_orders drop constraint raw_orders_vendor_vendor_order_id_key;
alter table raw_orders add constraint raw_orders_connection_order_key unique (connection_id, vendor_order_id);

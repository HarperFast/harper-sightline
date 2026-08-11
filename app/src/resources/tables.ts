// db.ts types tables as Table<T>; the read layer needs only the search/get subset.
import {
	Events as EventsTable,
	Findings as FindingsTable,
	Projections as ProjectionsTable,
	Expectations as ExpectationsTable,
	Deliveries as DeliveriesTable,
	Shops as ShopsTable,
	Credentials as CredentialsTable,
	EventSkus as EventSkusTable,
	InventoryItems as InventoryItemsTable,
	ShopLocations as ShopLocationsTable,
	DigestSubscriptions as DigestSubscriptionsTable,
} from '../db.ts';
import type { QueryTable } from '../api/queries.ts';

export const EventsQ = EventsTable as unknown as QueryTable;
export const FindingsQ = FindingsTable as unknown as QueryTable;
export const ProjectionsQ = ProjectionsTable as unknown as QueryTable;
export const ExpectationsQ = ExpectationsTable as unknown as QueryTable;
export const DeliveriesQ = DeliveriesTable as unknown as QueryTable;
export const ShopsQ = ShopsTable as unknown as QueryTable;
// Read ONLY for the credential's `status` (reauthorization state) in /setup —
// never for token material, which stays inside credentialStore.ts.
export const CredentialsQ = CredentialsTable as unknown as QueryTable;
export const EventSkusQ = EventSkusTable as unknown as QueryTable;
export const InventoryItemsQ = InventoryItemsTable as unknown as QueryTable;
export const ShopLocationsQ = ShopLocationsTable as unknown as QueryTable;
// Read ONLY for `email`/`cadence`/`status` in /privacy's notifications
// disclosure — stated, never echoed (see getPrivacy in src/api/queries.ts).
export const DigestSubscriptionsQ = DigestSubscriptionsTable as unknown as QueryTable;

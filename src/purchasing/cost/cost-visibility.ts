import { staffWith } from '../../iam/authorization/staff-permission.field-middleware';
import { Permission } from '../../iam/authorization/permissions';

export const COST_VIEW_PERMISSION: Permission = 'inventory.cost.view';

/**
 * Field options for anything that reveals a unit cost (cost prices, purchase-order costs, receipt and stock values at
 * cost): only staff holding inventory.cost.view read it; others get FORBIDDEN on that field. Such fields are nullable
 * so the rest of the object still resolves.
 */
export const COST_VIEWERS_ONLY = { nullable: true, middleware: [staffWith(COST_VIEW_PERMISSION)] };

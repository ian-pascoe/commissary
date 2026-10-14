/**
 * The management API contract shared by the Worker's tests and the control panel (`web/`): endpoint paths, query
 * schemas, response and error bodies of the `/v8/management` routes the panel uses. The handlers themselves stay plain
 * router handlers (`../routes.ts`); `test/management-contract.test.ts` checks their real responses against these
 * schemas through the generated client.
 *
 * Browser-safe: modules under `contract/` import `effect` and each other only.
 */
import { HttpApi } from "effect/http-api";
import { ApiKeysGroup } from "./api-keys.ts";
import { CatalogGroup } from "./catalog.ts";
import { CredentialsGroup } from "./credentials.ts";
import { GrantsGroup } from "./grants.ts";
import { MembersGroup } from "./members.ts";
import { OAuthGroup } from "./oauth.ts";
import { ManagementKeysGroup } from "./management-keys.ts";
import { OrgsGroup } from "./orgs.ts";
import { PeopleGroup } from "./people.ts";
import { PricesGroup } from "./prices.ts";
import { ProxyKeysGroup } from "./proxy-keys.ts";
import { RoutingGroup } from "./routing.ts";
import { SettingsGroup } from "./settings.ts";
import { SpendGroup } from "./spend.ts";
import { SsoGroup } from "./sso.ts";
import { UsageGroupApi } from "./usage.ts";

export const MANAGEMENT_API_PREFIX = "/v8/management";

export class ManagementApi extends HttpApi.make("management")
  .add(CredentialsGroup)
  .add(UsageGroupApi)
  .add(OAuthGroup)
  .add(ApiKeysGroup)
  .add(RoutingGroup)
  .add(CatalogGroup)
  .add(SettingsGroup)
  .add(OrgsGroup)
  .add(PricesGroup)
  .add(MembersGroup)
  .add(ProxyKeysGroup)
  .add(GrantsGroup)
  .add(SpendGroup)
  .add(PeopleGroup)
  .add(ManagementKeysGroup)
  .add(SsoGroup)
  .prefix(MANAGEMENT_API_PREFIX) {}

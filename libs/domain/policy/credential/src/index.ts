/**
 * Policy Credential 子域入口（DES-5.3）。
 * 短时凭证签发/回收/熔断；仅消费 evidenceId，不复算裁决。
 */
export { CredentialService, CREDENTIAL_JTI_REGISTRY } from './credential.service';
export type {
  CredentialJtiRegistry,
  JtiRegistryEntry,
} from './credential.service';
export { CredentialModule } from './credential.module';

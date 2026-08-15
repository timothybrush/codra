export interface InstanceIdStore {
  getOrCreateInstanceId(): Promise<string>;
}

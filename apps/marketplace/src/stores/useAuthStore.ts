import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface Principal {
  id: string;
  name: string;
  tenantId: string;
  roles: string[];
}

export const useAuthStore = defineStore('auth', () => {
  const principal = ref<Principal | null>(null);
  const authenticated = ref(false);

  function setPrincipal(p: Principal) {
    principal.value = p;
    authenticated.value = true;
  }

  function clear() {
    principal.value = null;
    authenticated.value = false;
  }

  return { principal, authenticated, setPrincipal, clear };
});

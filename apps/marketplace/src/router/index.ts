import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
    },
    {
      path: '/skill/:skillId',
      name: 'detail',
      component: () => import('../views/DetailView.vue'),
    },
    {
      path: '/skill/:skillId/install',
      name: 'install',
      component: () => import('../views/InstallView.vue'),
    },
  ],
});

export default router;

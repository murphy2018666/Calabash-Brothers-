<template>
  <div id="app">
    <header class="app-header">
      <router-link to="/" class="logo">Aegisci Skill Marketplace</router-link>
      <nav>
        <router-link to="/" class="nav-link">Browse</router-link>
      </nav>
    </header>
    <main class="app-main">
      <router-view />
    </main>
    <footer class="app-footer">
      <span>Aegisci Skill Marketplace v0.1.0</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

:root {
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-success: #16a34a;
  --color-danger: #dc2626;
  --color-warning: #d97706;
  --color-bg: #f8fafc;
  --color-surface: #ffffff;
  --color-border: #e2e8f0;
  --color-text: #1e293b;
  --color-text-muted: #64748b;
  --radius: 8px;
  --shadow: 0 1px 3px rgba(0,0,0,0.1);
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--color-bg);
  color: var(--color-text);
  min-height: 100vh;
}

.app-header {
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  padding: 1rem 2rem;
  display: flex;
  align-items: center;
  gap: 2rem;
  box-shadow: var(--shadow);
}

.logo {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--color-primary);
  text-decoration: none;
}

.nav-link {
  color: var(--color-text-muted);
  text-decoration: none;
  padding: 0.5rem 1rem;
  border-radius: var(--radius);
  transition: all 0.2s;
}

.nav-link:hover {
  color: var(--color-primary);
  background: #eff6ff;
}

.app-main {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
}

.app-footer {
  text-align: center;
  padding: 1rem;
  color: var(--color-text-muted);
  font-size: 0.875rem;
  border-top: 1px solid var(--color-border);
}
</style>

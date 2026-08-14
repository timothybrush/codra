import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppShell } from './components/layout/app-shell';
import { RouteErrorBoundary } from './components/shared/route-error-boundary';

const LandingPage = React.lazy(() => import('./pages/landing').then(m => ({ default: m.LandingPage })));
const DashboardPage = React.lazy(() => import('./pages/dashboard').then(m => ({ default: m.DashboardPage })));
const LoginPage = React.lazy(() => import('./pages/login').then(m => ({ default: m.LoginPage })));
const JobsPage = React.lazy(() => import('./pages/jobs').then(m => ({ default: m.JobsPage })));
const JobDetailPage = React.lazy(() => import('./pages/job-detail').then(m => ({ default: m.JobDetailPage })));
const JobLogsPage = React.lazy(() => import('./pages/job-logs').then(m => ({ default: m.JobLogsPage })));
const ReposPage = React.lazy(() => import('./pages/repos').then(m => ({ default: m.ReposPage })));
const StatsPage = React.lazy(() => import('./pages/stats').then(m => ({ default: m.StatsPage })));
const SettingsPage = React.lazy(() => import('./pages/settings').then(m => ({ default: m.SettingsPage })));
const AccountPage = React.lazy(() => import('./pages/account').then(m => ({ default: m.AccountPage })));
const NotFoundPage = React.lazy(() => import('./pages/not-found').then(m => ({ default: m.NotFoundPage })));

import './app.css';

import { ThemeProvider } from '@codra/ui/theme';
import { useIsDarkMode } from '@codra/ui/hooks';
import { SmoothScroll } from '@codra/ui/motion';

function ToasterWrapper() {
  const isDark = useIsDarkMode();
  return (
    <Toaster
      theme={isDark ? 'dark' : 'light'}
      position="bottom-right"
      closeButton
      gap={8}
      toastOptions={{
        duration: 4000,
        classNames: {
          toast: 'codra-toast',
          title: 'codra-toast-title',
          description: 'codra-toast-description',
          actionButton: 'codra-toast-action',
          cancelButton: 'codra-toast-cancel',
          closeButton: 'codra-toast-close',
          icon: 'codra-toast-icon',
          loader: 'codra-toast-loader',
          success: 'codra-toast-success',
          error: 'codra-toast-error',
          warning: 'codra-toast-warning',
          info: 'codra-toast-info',
          loading: 'codra-toast-loading',
        },
      }}
    />
  );
}

// Render failures (including a failed lazy chunk) bubble to the branch's
// `errorElement` so there is one styled fallback instead of two.
const withSuspense = (Component: React.ComponentType, isFullPage = false) => (
  <Suspense fallback={<div role="status" aria-busy="true" className={`flex items-center justify-center ${isFullPage ? 'h-screen' : 'h-full w-full'}`} />}>
    <Component />
  </Suspense>
);

const router = createBrowserRouter([
  {
    path: '/',
    element: withSuspense(LandingPage, true),
    errorElement: <RouteErrorBoundary />,
  },
  {
    path: '/login',
    element: withSuspense(LoginPage, true),
    errorElement: <RouteErrorBoundary />,
  },
  {
    element: <AppShell />,
    errorElement: <RouteErrorBoundary />,
    // Per child too, not just on the layout: React Router replaces the whole matched branch, so a
    // boundary only on the branch would take the sidebar and header down with a single page.
    children: [
      { path: 'dashboard', element: withSuspense(DashboardPage), errorElement: <RouteErrorBoundary inline /> },
      { path: 'jobs', element: withSuspense(JobsPage), errorElement: <RouteErrorBoundary inline /> },
      { path: 'jobs/:id', element: withSuspense(JobDetailPage), errorElement: <RouteErrorBoundary inline /> },
      { path: 'jobs/:id/logs', element: withSuspense(JobLogsPage), errorElement: <RouteErrorBoundary inline /> },
      { path: 'repos', element: withSuspense(ReposPage), errorElement: <RouteErrorBoundary inline /> },
      { path: 'stats', element: withSuspense(StatsPage), errorElement: <RouteErrorBoundary inline /> },
      { path: 'settings', element: withSuspense(SettingsPage), errorElement: <RouteErrorBoundary inline /> },
      { path: 'account', element: withSuspense(AccountPage), errorElement: <RouteErrorBoundary inline /> },
    ],
  },
  {
    path: '*',
    element: withSuspense(NotFoundPage, true),
    errorElement: <RouteErrorBoundary />,
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <SmoothScroll root lerp={0.16} duration={0.9}>
        <RouterProvider router={router} />
        <ToasterWrapper />
      </SmoothScroll>
    </ThemeProvider>
  </React.StrictMode>,
);

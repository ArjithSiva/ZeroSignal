import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import { Spinner } from './components/Badges.jsx';
import { homeFor, useAuth } from './context/AuthContext.jsx';
import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Receiver = lazy(() => import('./pages/Receiver.jsx'));
const Analytics = lazy(() => import('./pages/Analytics.jsx'));
const Admin = lazy(() => import('./pages/Admin.jsx'));
const SettingsPage = lazy(() => import('./pages/Settings.jsx'));
const Demo = lazy(() => import('./pages/Demo.jsx'));

const OPS = ['broadcaster', 'admin'];

function NotFound() {
  const { user } = useAuth();
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <h1 className="font-display text-3xl font-bold">Page not found</h1>
      <p className="mt-2 text-muted">That address does not exist in ZeroSignal.</p>
      <a className="mt-4 inline-block text-primary underline" href={user ? homeFor(user.role) : '/'}>Go to your home page</a>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword mode="reset" />} />
        <Route path="/setup-account" element={<ResetPassword mode="invite" />} />
        <Route element={<Layout />}>
          <Route path="/dashboard" element={<ProtectedRoute roles={OPS}><Dashboard /></ProtectedRoute>} />
          <Route path="/analytics" element={<ProtectedRoute roles={OPS}><Analytics /></ProtectedRoute>} />
          <Route path="/demo" element={<ProtectedRoute roles={OPS}><Demo /></ProtectedRoute>} />
          <Route path="/admin" element={<ProtectedRoute roles={['admin']}><Admin /></ProtectedRoute>} />
          <Route path="/receiver/:broadcastId?" element={<ProtectedRoute><Receiver /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

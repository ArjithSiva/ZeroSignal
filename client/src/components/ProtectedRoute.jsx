import { Navigate, useLocation } from 'react-router-dom';
import { useAuth, homeFor } from '../context/AuthContext.jsx';
import { Spinner } from './Badges.jsx';

/** Gate by sign-in and (optionally) role. Wrong role → that user's own home, not a dead end. */
export default function ProtectedRoute({ roles, children }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner label="Restoring your session" />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return children;
}

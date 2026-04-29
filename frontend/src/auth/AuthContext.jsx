import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  signIn as amplifySignIn,
  signUp as amplifySignUp,
  signOut as amplifySignOut,
  confirmSignUp as amplifyConfirmSignUp,
  resendSignUpCode,
  resetPassword,
  confirmResetPassword,
  fetchAuthSession,
  getCurrentUser,
} from "aws-amplify/auth";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // { username, email, groups[] }
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const current = await getCurrentUser();
      const session = await fetchAuthSession();
      const claims = session?.tokens?.idToken?.payload || {};
      const groupsClaim = claims["cognito:groups"];
      const groups = Array.isArray(groupsClaim)
        ? groupsClaim
        : groupsClaim
        ? [groupsClaim]
        : [];
      setUser({
        username: current.username,
        email: claims.email || current.signInDetails?.loginId || "",
        groups,
      });
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({
      user,
      loading,
      isAdmin: !!user?.groups?.includes("admins"),
      async signIn(email, password) {
        const result = await amplifySignIn({
          username: email,
          password,
          options: { authFlowType: "USER_PASSWORD_AUTH" },
        });
        await refresh();
        return result;
      },
      async signUp(email, password) {
        return amplifySignUp({
          username: email,
          password,
          options: { userAttributes: { email } },
        });
      },
      async confirmSignUp(email, code) {
        return amplifyConfirmSignUp({ username: email, confirmationCode: code });
      },
      async resendCode(email) {
        return resendSignUpCode({ username: email });
      },
      async signOut() {
        await amplifySignOut();
        setUser(null);
      },
      async forgotPassword(email) {
        return resetPassword({ username: email });
      },
      async confirmForgotPassword(email, code, newPassword) {
        return confirmResetPassword({
          username: email,
          confirmationCode: code,
          newPassword,
        });
      },
      async getIdToken() {
        const session = await fetchAuthSession();
        return session?.tokens?.idToken?.toString() || null;
      },
      refresh,
    }),
    [user, loading, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

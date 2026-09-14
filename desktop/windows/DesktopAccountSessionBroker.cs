using System.Security.Principal;

namespace Swir.Desktop.Host;

/// <summary>
/// Read-only bridge between the portable SWIR identity/session model and the
/// currently authenticated Windows desktop session. It deliberately does not
/// expose credentials, password material, security tokens, SID values, profile
/// paths or account-management mutations.
/// </summary>
internal sealed class DesktopAccountSessionBroker
{
    private readonly string _hostSessionId;
    private readonly DateTimeOffset _hostStartedAt;

    public DesktopAccountSessionBroker(string hostSessionId)
    {
        if (string.IsNullOrWhiteSpace(hostSessionId))
            throw new ArgumentException("Host session id is required.", nameof(hostSessionId));
        _hostSessionId = hostSessionId;
        _hostStartedAt = DateTimeOffset.UtcNow;
    }

    public object Describe()
    {
        var account = ReadAccount();
        return new
        {
            schema = "swir.desktop-identity/0.1",
            provider = "windows-session",
            readOnly = true,
            nativeAuthentication = true,
            accountManagement = false,
            credentialExposure = false,
            account,
            session = ReadSession(account)
        };
    }

    public object Account() => ReadAccount();

    public object Session()
    {
        var account = ReadAccount();
        return ReadSession(account);
    }

    private static AccountSnapshot ReadAccount()
    {
        string authenticationType = "windows";
        bool authenticated = false;
        bool administrator = false;

        try
        {
            using var identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query);
            authenticated = identity?.IsAuthenticated == true;
            if (!string.IsNullOrWhiteSpace(identity?.AuthenticationType))
                authenticationType = identity.AuthenticationType!.Trim().ToLowerInvariant();

            if (identity is not null)
            {
                var principal = new WindowsPrincipal(identity);
                administrator = principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
        }
        catch
        {
            // Identity probing is diagnostic only. Environment-provided account
            // metadata remains available while privileged details fail closed.
        }

        var userName = Safe(Environment.UserName, "user");
        var domain = Safe(Environment.UserDomainName, string.Empty);
        return new AccountSnapshot(
            Schema: "swir.desktop-account/0.1",
            UserName: userName,
            DisplayName: userName,
            Domain: domain,
            AuthenticationType: authenticationType,
            Authenticated: authenticated,
            Administrator: administrator,
            Native: true,
            CredentialBackedByOs: true);
    }

    private SessionSnapshot ReadSession(AccountSnapshot account)
    {
        var interactive = Environment.UserInteractive;
        var sessionName = Safe(Environment.GetEnvironmentVariable("SESSIONNAME"), interactive ? "interactive" : "non-interactive");
        return new SessionSnapshot(
            Schema: "swir.desktop-session/0.1",
            SessionId: _hostSessionId,
            AccountUserName: account.UserName,
            SessionName: sessionName,
            Interactive: interactive,
            Native: true,
            Locked: false,
            LockStateAuthoritative: false,
            StartedAt: _hostStartedAt);
    }

    private static string Safe(string? value, string fallback)
    {
        var normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0) return fallback;
        return normalized.Length <= 128 ? normalized : normalized[..128];
    }

    internal sealed record AccountSnapshot(
        string Schema,
        string UserName,
        string DisplayName,
        string Domain,
        string AuthenticationType,
        bool Authenticated,
        bool Administrator,
        bool Native,
        bool CredentialBackedByOs);

    internal sealed record SessionSnapshot(
        string Schema,
        string SessionId,
        string AccountUserName,
        string SessionName,
        bool Interactive,
        bool Native,
        bool Locked,
        bool LockStateAuthoritative,
        DateTimeOffset StartedAt);
}

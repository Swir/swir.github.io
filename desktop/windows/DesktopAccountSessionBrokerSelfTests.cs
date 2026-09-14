using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopAccountSessionBrokerSelfTests
{
    private static int Main()
    {
        try
        {
            var broker = new DesktopAccountSessionBroker("ci-session-001");
            AssertSchema(broker.Describe(), "swir.desktop-identity/0.1");
            AssertSchema(broker.Account(), "swir.desktop-account/0.1");
            AssertSchema(broker.Session(), "swir.desktop-session/0.1");

            using var identity = JsonDocument.Parse(JsonSerializer.Serialize(broker.Describe()));
            var root = identity.RootElement;
            if (!root.GetProperty("readOnly").GetBoolean())
                throw new InvalidOperationException("Desktop identity broker must remain read-only.");
            if (!root.GetProperty("nativeAuthentication").GetBoolean())
                throw new InvalidOperationException("Desktop identity broker must report native authentication binding.");
            if (root.GetProperty("accountManagement").GetBoolean())
                throw new InvalidOperationException("Account management must remain disabled until a privileged lifecycle exists.");
            if (root.GetProperty("credentialExposure").GetBoolean())
                throw new InvalidOperationException("Credential exposure must always be false.");

            var serialized = JsonSerializer.Serialize(new
            {
                identity = broker.Describe(),
                account = broker.Account(),
                session = broker.Session()
            });

            foreach (var forbidden in new[]
            {
                "Password", "PasswordHash", "Credential", "AccessToken", "RefreshToken",
                "SecurityToken", "Sid", "ProfilePath", "HomeDirectory", "Secret", "Pin"
            })
            {
                if (serialized.Contains($"\"{forbidden}\"", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"Security regression: identity broker exposed forbidden field {forbidden}.");
            }

            using var session = JsonDocument.Parse(JsonSerializer.Serialize(broker.Session()));
            if (session.RootElement.GetProperty("sessionId").GetString() != "ci-session-001")
                throw new InvalidOperationException("Native account/session broker must bind to the Desktop Host session id.");
            if (session.RootElement.GetProperty("lockStateAuthoritative").GetBoolean())
                throw new InvalidOperationException("Lock state must not be claimed authoritative before a native lock/unlock observer exists.");

            Console.WriteLine("Desktop Account/Session Broker self-tests passed.");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    private static void AssertSchema(object value, string schema)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(value));
        if (!document.RootElement.TryGetProperty("schema", out var actual) || actual.GetString() != schema)
            throw new InvalidOperationException($"Expected schema {schema}.");
    }
}

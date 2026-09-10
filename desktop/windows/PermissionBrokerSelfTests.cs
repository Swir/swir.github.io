namespace Swir.Desktop.Host.SelfTests;

internal static class PermissionBrokerSelfTests
{
    public static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-permission-selftest-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(root);
            var policyPath = Path.Combine(root, "app-policy.json");
            File.WriteAllText(policyPath, """
            {
              "schema": "swir.desktop-policy/0.1",
              "packages": [
                { "packageId": "swir.code", "entry": "./swir-code.html", "permissions": ["files.read", "files.write", "clipboard"] },
                { "packageId": "swir.chat", "entry": "./swir-chat.html", "permissions": ["network", "storage", "identity.basic", "notifications"] }
              ]
            }
            """);

            var capabilities = new Swir.Desktop.Host.CapabilityBroker();
            var policies = new Swir.Desktop.Host.ExecutionPolicyCatalog(policyPath);
            var broker = new Swir.Desktop.Host.PermissionBroker(capabilities, policies);

            broker.SynchronizeApplicationContexts(new[]
            {
                new Swir.Desktop.Host.PermissionBroker.PackageContextRequest("swir.code", new[] { "files.read", "files.write" }),
                new Swir.Desktop.Host.PermissionBroker.PackageContextRequest("swir.chat", new[] { "storage" })
            });

            var codeToken = broker.RequirePackageExecutionToken("swir.code");
            var chatToken = broker.RequirePackageExecutionToken("swir.chat");

            Require(broker.Can(codeToken, "filesystem.sandbox.read"), "swir.code did not receive sandbox read from files.write");
            Require(broker.Can(codeToken, "filesystem.sandbox.write"), "swir.code did not receive sandbox write from files.write");
            Require(broker.Can(chatToken, "filesystem.sandbox.read"), "swir.chat did not receive sandbox read from storage");
            Require(broker.Can(chatToken, "filesystem.sandbox.write"), "swir.chat did not receive sandbox write from storage");

            broker.AuthorizePackageTarget(codeToken, "swir.code", "appdata", "get");
            broker.AuthorizePackageTarget(chatToken, "swir.chat", "appdata", "set");
            ExpectCode("EXECUTION_IDENTITY_MISMATCH", () => broker.AuthorizePackageTarget(codeToken, "swir.chat", "appdata", "get"));
            ExpectCode("EXECUTION_IDENTITY_MISMATCH", () => broker.AuthorizePackageTarget(chatToken, "swir.code", "appdata", "set"));

            ExpectCode("PACKAGE_PERMISSION_ESCALATION", () => broker.SynchronizeApplicationContexts(new[]
            {
                new Swir.Desktop.Host.PermissionBroker.PackageContextRequest("swir.code", new[] { "storage" })
            }));

            var filePath = Path.Combine(root, "capability.txt");
            File.WriteAllText(filePath, "capability owner test");
            dynamic descriptor = capabilities.RegisterFile(filePath, "swir.code");
            var capabilityToken = (string)descriptor.token;
            capabilities.Describe(capabilityToken, "swir.code");
            ExpectCode("CAPABILITY_OWNER_MISMATCH", () => capabilities.Describe(capabilityToken, "swir.chat"));

            broker.SynchronizeApplicationContexts(new[]
            {
                new Swir.Desktop.Host.PermissionBroker.PackageContextRequest("swir.code", Array.Empty<string>()),
                new Swir.Desktop.Host.PermissionBroker.PackageContextRequest("swir.chat", new[] { "storage" })
            });

            ExpectCode("EXECUTION_CONTEXT_INVALID", () => broker.Authorize(codeToken, "appdata", "get", "swir.code"));
            var downgradedCodeToken = broker.RequirePackageExecutionToken("swir.code");
            ExpectCode("PERMISSION_DENIED", () => broker.AuthorizePackageTarget(downgradedCodeToken, "swir.code", "appdata", "get"));
            ExpectCode("CAPABILITY_INVALID", () => capabilities.Describe(capabilityToken, "swir.code"));

            broker.SynchronizeApplicationContexts(new[]
            {
                new Swir.Desktop.Host.PermissionBroker.PackageContextRequest("swir.chat", new[] { "storage" })
            });
            ExpectCode("PACKAGE_CONTEXT_NOT_READY", () => broker.RequirePackageExecutionToken("swir.code"));
            ExpectCode("EXECUTION_CONTEXT_INVALID", () => broker.Authorize(downgradedCodeToken, "security", "contextInfo"));

            broker.SynchronizeApplicationContexts(Array.Empty<Swir.Desktop.Host.PermissionBroker.PackageContextRequest>());
            ExpectCode("PACKAGE_CONTEXT_NOT_READY", () => broker.RequirePackageExecutionToken("swir.chat"));
            ExpectCode("EXECUTION_CONTEXT_INVALID", () => broker.Authorize(chatToken, "appdata", "get", "swir.chat"));

            Console.WriteLine("SWIR Permission Broker self-tests: PASS");
            Console.WriteLine("- package permission projection");
            Console.WriteLine("- cross-package App Data denial");
            Console.WriteLine("- undeclared grant escalation denial");
            Console.WriteLine("- capability owner isolation and revocation");
            Console.WriteLine("- permission downgrade invalidates execution context");
            Console.WriteLine("- uninstall removes execution context");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("SWIR Permission Broker self-tests: FAIL");
            Console.Error.WriteLine(ex);
            return 1;
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static void ExpectCode(string code, Action action)
    {
        try
        {
            action();
            throw new InvalidOperationException($"Expected BridgeException {code} was not thrown.");
        }
        catch (Swir.Desktop.Host.BridgeException ex) when (ex.Code == code)
        {
        }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}

using System.Security.Cryptography;
using System.Text.Json;
using Swir.Desktop.Host;

internal static class DesktopUpdatePreparationBridgeSelfTests
{
    private static int _passed;

    private static async Task Main()
    {
        PolicyMissingIsDisabled();
        PolicyRejectsUnsafeFeed();
        PolicyAcceptsPinnedHttpsFeed();
        TrustedShellAndConfigurationGate();
        await QueueAcknowledgeAndComplete();
        await FailureAndRetry();
        Console.WriteLine($"Desktop update preparation bridge self-tests passed: {_passed}");
    }

    private static void PolicyMissingIsDisabled()
    {
        var root = TempRoot();
        try
        {
            var policy = DesktopUpdateReleasePolicy.Load(Path.Combine(root, "missing.json"));
            Expect(!policy.Enabled && policy.ManifestUri is null && policy.Channel == "stable", "missing policy fails closed as disabled");
        }
        finally { TryDelete(root); }
    }

    private static void PolicyRejectsUnsafeFeed()
    {
        var root = TempRoot();
        try
        {
            using var rsa = RSA.Create(2048);
            var path = Path.Combine(root, "policy.json");
            File.WriteAllText(path, PolicyJson(true, "http://updates.swir.example/stable.json", rsa.ExportSubjectPublicKeyInfoPem()));
            ExpectCode("UPDATE_MANIFEST_URL_INVALID", () => DesktopUpdateReleasePolicy.Load(path), "non-HTTPS manifest rejected");

            File.WriteAllText(path, PolicyJson(true, "https://updates.swir.example/stable.json", "not-a-key"));
            ExpectCode("UPDATE_KEY_INVALID", () => DesktopUpdateReleasePolicy.Load(path), "invalid release key rejected");
        }
        finally { TryDelete(root); }
    }

    private static void PolicyAcceptsPinnedHttpsFeed()
    {
        var root = TempRoot();
        try
        {
            using var rsa = RSA.Create(2048);
            var path = Path.Combine(root, "policy.json");
            File.WriteAllText(path, PolicyJson(true, "https://updates.swir.example/stable.json", rsa.ExportSubjectPublicKeyInfoPem()));
            var policy = DesktopUpdateReleasePolicy.Load(path);
            Expect(policy.Enabled && policy.ManifestUri?.Host == "updates.swir.example", "pinned HTTPS manifest accepted");
            Expect(policy.ManifestHosts.SequenceEqual(new[] { "updates.swir.example" }), "manifest allowlist normalized");
            Expect(policy.PackageHosts.SequenceEqual(new[] { "downloads.swir.example" }), "package allowlist normalized");
        }
        finally { TryDelete(root); }
    }

    private static void TrustedShellAndConfigurationGate()
    {
        var disabled = new DesktopUpdatePreparationBridgeCoordinator(() => false, _ => Task.FromResult<object?>(new { ok = true }));
        ExpectCode("UPDATE_BRIDGE_TRUST_REQUIRED", () => disabled.QueuePrepare(false), "untrusted caller rejected before preparation");
        ExpectCode("UPDATE_RELEASE_FEED_NOT_CONFIGURED", () => disabled.QueuePrepare(true), "disabled release feed rejected fail closed");
    }

    private static async Task QueueAcknowledgeAndComplete()
    {
        var calls = 0;
        var coordinator = new DesktopUpdatePreparationBridgeCoordinator(
            () => true,
            _ => { calls++; return Task.FromResult<object?>(new { ready = true, targetVersion = "0.5.2" }); });

        var accepted = coordinator.QueuePrepare(true);
        Expect(calls == 0, "preparation does not start before bridge acknowledgement is released");
        ExpectCode("UPDATE_PREPARATION_ALREADY_RUNNING", () => coordinator.QueuePrepare(true), "single-flight rejects duplicate queue");
        var result = await coordinator.ExecuteQueuedAsync();
        Expect(calls == 1 && result is not null, "acknowledged preparation executes exactly once");
        var state = JsonSerializer.Serialize(coordinator.Describe());
        Expect(state.Contains("\"state\":\"ready\"", StringComparison.Ordinal), "successful preparation reaches ready state");

        coordinator.ResetTerminalState();
        coordinator.QueuePrepare(true);
        coordinator.CancelQueuedAfterResponseFailure();
        Expect(calls == 1, "failed bridge response cancels queued preparation before side effects");
        await ExpectCodeAsync("UPDATE_PREPARATION_NOT_QUEUED", coordinator.ExecuteQueuedAsync, "cancelled queue cannot execute");
        _ = accepted;
    }

    private static async Task FailureAndRetry()
    {
        var fail = true;
        var coordinator = new DesktopUpdatePreparationBridgeCoordinator(
            () => true,
            _ => fail
                ? Task.FromException<object?>(new UpdateSecurityException("UPDATE_SIGNATURE_INVALID", "signature rejected"))
                : Task.FromResult<object?>(new { ready = true }));

        coordinator.QueuePrepare(true);
        await ExpectCodeAsync("UPDATE_SIGNATURE_INVALID", coordinator.ExecuteQueuedAsync, "preparation security failure propagated");
        var failedState = JsonSerializer.Serialize(coordinator.Describe());
        Expect(failedState.Contains("UPDATE_SIGNATURE_INVALID", StringComparison.Ordinal), "failure state preserves security code");
        coordinator.ResetTerminalState();
        fail = false;
        coordinator.QueuePrepare(true);
        await coordinator.ExecuteQueuedAsync();
        Expect(JsonSerializer.Serialize(coordinator.Describe()).Contains("\"state\":\"ready\"", StringComparison.Ordinal), "terminal failure can be explicitly reset and retried");
    }

    private static string PolicyJson(bool enabled, string manifestUrl, string key) => JsonSerializer.Serialize(new
    {
        Schema = DesktopUpdateReleasePolicy.PolicySchema,
        Enabled = enabled,
        Channel = "stable",
        ManifestUrl = manifestUrl,
        ManifestHosts = new[] { "updates.swir.example" },
        PackageHosts = new[] { "downloads.swir.example" },
        PublicKeyPem = key
    });

    private static string TempRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-prep-bridge", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static void TryDelete(string path) { try { Directory.Delete(path, true); } catch { } }

    private static void Expect(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException("FAILED: " + name);
        _passed++;
    }

    private static void ExpectCode(string code, Action action, string name)
    {
        try { action(); }
        catch (DesktopUpdateBridgeCommandException ex) when (ex.Code == code) { _passed++; return; }
        catch (UpdateSecurityException ex) when (ex.Code == code) { _passed++; return; }
        throw new InvalidOperationException($"FAILED: {name} (expected {code})");
    }

    private static async Task ExpectCodeAsync(string code, Func<CancellationToken, Task<object?>> action, string name)
    {
        try { await action(CancellationToken.None); }
        catch (DesktopUpdateBridgeCommandException ex) when (ex.Code == code) { _passed++; return; }
        catch (UpdateSecurityException ex) when (ex.Code == code) { _passed++; return; }
        throw new InvalidOperationException($"FAILED: {name} (expected {code})");
    }
}

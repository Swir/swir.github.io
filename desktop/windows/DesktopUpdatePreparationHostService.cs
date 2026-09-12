namespace Swir.Desktop.Host;

/// <summary>
/// Production composition root for the Desktop update preparation pipeline.
/// It keeps release policy, canonical deployment paths and the shell-only
/// preparation bridge behind one fail-closed service so MainWindow never needs
/// to assemble network/update primitives from WebView supplied data.
/// </summary>
internal sealed class DesktopUpdatePreparationHostService
{
    public const string HostServiceSchema = "swir.desktop-update-preparation-host/0.2";
    public const string CheckSchema = "swir.desktop-update-check/0.1";
    public static readonly Version CurrentDesktopVersion = new(0, 5, 1);

    private readonly string _policyPath;
    private readonly string _currentInstallRoot;
    private readonly string _updaterWorkerPath;
    private readonly string _deploymentRoot;
    private readonly string _transactionsRoot;
    private readonly DesktopUpdatePreparationBridgeCoordinator _bridge;
    private readonly Func<UpdateBroker, Uri, IEnumerable<string>, UpdateManifestClient> _manifestClientFactory;

    public DesktopUpdatePreparationHostService(
        string? policyPath = null,
        string? currentInstallRoot = null,
        string? updaterWorkerPath = null,
        string? deploymentRoot = null,
        string? transactionsRoot = null,
        Func<UpdateBroker, Uri, IEnumerable<string>, UpdateManifestClient>? manifestClientFactory = null)
    {
        _policyPath = Path.GetFullPath(policyPath ?? Path.Combine(AppContext.BaseDirectory, "desktop-update-policy.json"));
        _deploymentRoot = Path.GetFullPath(deploymentRoot ?? DesktopUpdatePaths.DeploymentRoot);
        _transactionsRoot = Path.GetFullPath(transactionsRoot ?? DesktopUpdatePaths.TransactionsRoot);
        _currentInstallRoot = Path.GetFullPath(currentInstallRoot ?? Path.Combine(_deploymentRoot, "Current"));
        _updaterWorkerPath = Path.GetFullPath(updaterWorkerPath ?? DesktopUpdatePaths.UpdaterWorkerPath);
        _manifestClientFactory = manifestClientFactory ?? ((broker, uri, hosts) => new UpdateManifestClient(broker, uri, hosts));
        _bridge = new DesktopUpdatePreparationBridgeCoordinator(IsPreparationConfigured, PrepareCoreAsync);
    }

    public object Describe()
    {
        DesktopUpdateReleasePolicy policy;
        try { policy = DesktopUpdateReleasePolicy.Load(_policyPath); }
        catch (UpdateSecurityException ex)
        {
            return new
            {
                schema = HostServiceSchema,
                configured = false,
                feedConfigured = false,
                failClosed = true,
                currentVersion = CurrentDesktopVersion.ToString(),
                policy = new { enabled = false, invalid = true, code = ex.Code, message = ex.Message },
                environment = DescribeEnvironment(),
                preparation = _bridge.Describe()
            };
        }

        return new
        {
            schema = HostServiceSchema,
            configured = IsPreparationConfigured(policy),
            feedConfigured = IsReleaseFeedConfigured(policy),
            failClosed = true,
            currentVersion = CurrentDesktopVersion.ToString(),
            policy = policy.Describe(),
            environment = DescribeEnvironment(),
            preparation = _bridge.Describe()
        };
    }

    public async Task<object> CheckAsync(bool trustedShell, CancellationToken cancellationToken = default)
    {
        if (!trustedShell)
            throw new DesktopUpdateBridgeCommandException("UPDATE_BRIDGE_TRUST_REQUIRED", "Only the trusted SWIR system shell may check Desktop release feeds.");

        var policy = DesktopUpdateReleasePolicy.Load(_policyPath);
        if (!IsReleaseFeedConfigured(policy))
            throw new DesktopUpdateBridgeCommandException("UPDATE_RELEASE_FEED_NOT_CONFIGURED", "Desktop update check requires an enabled signed release policy.");

        var broker = new UpdateBroker(policy.PublicKeyPem!, policy.PackageHosts);
        using var manifestClient = _manifestClientFactory(broker, policy.ManifestUri!, policy.ManifestHosts);
        try
        {
            var update = await manifestClient.FetchAndVerifyAsync(CurrentDesktopVersion, policy.Channel, cancellationToken).ConfigureAwait(false);
            return new
            {
                schema = CheckSchema,
                updateAvailable = true,
                currentVersion = CurrentDesktopVersion.ToString(),
                targetVersion = update.Version.ToString(),
                channel = update.Channel,
                publishedAt = update.PublishedAt,
                package = new { host = update.PackageUri.Host, size = update.Size, sha256 = update.Sha256, keyId = update.KeyId },
                verified = true
            };
        }
        catch (UpdateSecurityException ex) when (ex.Code == "UPDATE_NOT_NEWER")
        {
            return new
            {
                schema = CheckSchema,
                updateAvailable = false,
                currentVersion = CurrentDesktopVersion.ToString(),
                targetVersion = CurrentDesktopVersion.ToString(),
                channel = policy.Channel,
                verified = true,
                status = "current"
            };
        }
    }

    public object QueuePrepare(bool trustedShell) => _bridge.QueuePrepare(trustedShell);
    public object Cancel(bool trustedShell) => _bridge.CancelActive(trustedShell);
    public void CancelQueuedAfterResponseFailure() => _bridge.CancelQueuedAfterResponseFailure();
    public void ResetTerminalState() => _bridge.ResetTerminalState();
    public Task<object?> ExecuteQueuedAsync(CancellationToken cancellationToken = default)
        => _bridge.ExecuteQueuedAsync(cancellationToken);

    private bool IsPreparationConfigured()
    {
        try { return IsPreparationConfigured(DesktopUpdateReleasePolicy.Load(_policyPath)); }
        catch { return false; }
    }

    private static bool IsReleaseFeedConfigured(DesktopUpdateReleasePolicy policy)
        => policy.Enabled
           && policy.ManifestUri is not null
           && !string.IsNullOrWhiteSpace(policy.PublicKeyPem)
           && policy.ManifestHosts.Count > 0
           && policy.PackageHosts.Count > 0;

    private bool IsPreparationConfigured(DesktopUpdateReleasePolicy policy)
        => IsReleaseFeedConfigured(policy)
           && File.Exists(_updaterWorkerPath)
           && Directory.Exists(_currentInstallRoot)
           && IsCanonicalCurrentSlot(_currentInstallRoot, _deploymentRoot);

    private async Task<object?> PrepareCoreAsync(CancellationToken cancellationToken)
    {
        var policy = DesktopUpdateReleasePolicy.Load(_policyPath);
        if (!IsPreparationConfigured(policy))
            throw new DesktopUpdateBridgeCommandException(
                "UPDATE_RELEASE_FEED_NOT_CONFIGURED",
                "Desktop update preparation requires an enabled signed release policy, packaged Current slot and Updater Worker.");

        var broker = new UpdateBroker(policy.PublicKeyPem!, policy.PackageHosts);
        using var manifestClient = _manifestClientFactory(broker, policy.ManifestUri!, policy.ManifestHosts);
        var staging = new UpdateStagingBroker();
        using var downloadClient = new UpdateDownloadClient(staging);
        var handoff = new UpdateHandoffBroker();
        var journal = new UpdateTransactionJournal(_transactionsRoot);
        var coordinator = new DesktopUpdatePreparationCoordinator(
            manifestClient,
            downloadClient,
            staging,
            handoff,
            journal,
            _deploymentRoot,
            _transactionsRoot,
            _updaterWorkerPath);

        var result = await coordinator.PrepareAsync(
            CurrentDesktopVersion,
            policy.Channel,
            _currentInstallRoot,
            cancellationToken).ConfigureAwait(false);

        return new
        {
            ready = result.Ready,
            transactionId = result.TransactionId,
            currentVersion = result.CurrentVersion.ToString(),
            targetVersion = result.TargetVersion.ToString(),
            channel = result.Channel,
            sha256 = result.Sha256,
            size = result.Size,
            candidateVerified = true
        };
    }

    private object DescribeEnvironment() => new
    {
        currentInstallPresent = Directory.Exists(_currentInstallRoot),
        updaterWorkerPresent = File.Exists(_updaterWorkerPath),
        canonicalCurrentSlot = IsCanonicalCurrentSlot(_currentInstallRoot, _deploymentRoot),
        deploymentRoot = _deploymentRoot,
        transactionsRoot = _transactionsRoot
    };

    private static bool IsCanonicalCurrentSlot(string currentInstallRoot, string deploymentRoot)
    {
        var expected = Path.GetFullPath(Path.Combine(deploymentRoot, "Current"));
        var actual = Path.GetFullPath(currentInstallRoot);
        return string.Equals(
            actual.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
            expected.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
    }
}
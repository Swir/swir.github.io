using System.Diagnostics;

namespace Swir.Desktop.Host;

internal sealed class DesktopUpdatePreparationCoordinator
{
    private readonly UpdateManifestClient _manifestClient;
    private readonly UpdateDownloadClient _downloadClient;
    private readonly UpdateStagingBroker _staging;
    private readonly UpdateHandoffBroker _handoff;
    private readonly UpdateTransactionJournal _journal;
    private readonly string _deploymentRoot;
    private readonly string _transactionsRoot;
    private readonly string _updaterWorkerPath;
    private readonly Func<UpdateTransactionJournal.TransactionState, CancellationToken, Task>? _candidatePreparationOverride;

    public DesktopUpdatePreparationCoordinator(
        UpdateManifestClient manifestClient,
        UpdateDownloadClient downloadClient,
        UpdateStagingBroker staging,
        UpdateHandoffBroker handoff,
        UpdateTransactionJournal journal,
        string deploymentRoot,
        string transactionsRoot,
        string updaterWorkerPath)
        : this(manifestClient, downloadClient, staging, handoff, journal, deploymentRoot, transactionsRoot, updaterWorkerPath, null) { }

    internal DesktopUpdatePreparationCoordinator(
        UpdateManifestClient manifestClient,
        UpdateDownloadClient downloadClient,
        UpdateStagingBroker staging,
        UpdateHandoffBroker handoff,
        UpdateTransactionJournal journal,
        string deploymentRoot,
        string transactionsRoot,
        string updaterWorkerPath,
        Func<UpdateTransactionJournal.TransactionState, CancellationToken, Task>? candidatePreparationOverride)
    {
        _manifestClient = manifestClient ?? throw new ArgumentNullException(nameof(manifestClient));
        _downloadClient = downloadClient ?? throw new ArgumentNullException(nameof(downloadClient));
        _staging = staging ?? throw new ArgumentNullException(nameof(staging));
        _handoff = handoff ?? throw new ArgumentNullException(nameof(handoff));
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));
        _deploymentRoot = Path.GetFullPath(deploymentRoot ?? throw new ArgumentNullException(nameof(deploymentRoot)));
        _transactionsRoot = Path.GetFullPath(transactionsRoot ?? throw new ArgumentNullException(nameof(transactionsRoot)));
        _updaterWorkerPath = Path.GetFullPath(updaterWorkerPath ?? throw new ArgumentNullException(nameof(updaterWorkerPath)));
        _candidatePreparationOverride = candidatePreparationOverride;
    }

    public async Task<PreparationResult> PrepareAsync(Version currentVersion, string channel, string currentInstallRoot, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(currentVersion);
        if (string.IsNullOrWhiteSpace(channel)) throw new UpdateSecurityException("UPDATE_CHANNEL_INVALID", "Update channel is required.");
        if (string.IsNullOrWhiteSpace(currentInstallRoot)) throw new UpdateSecurityException("UPDATE_INSTALL_ROOT_INVALID", "Current installation root is required.");
        if (_journal.RecoverIncomplete().Count != 0)
            throw new UpdateSecurityException("UPDATE_PREPARATION_RECOVERY_REQUIRED", "An incomplete Desktop update transaction must be recovered before preparing another update.");

        UpdateTransactionJournal.TransactionState? transaction = null;
        try
        {
            var verified = await _manifestClient.FetchAndVerifyAsync(currentVersion, channel, cancellationToken).ConfigureAwait(false);
            var staged = await _downloadClient.DownloadAndStageAsync(verified, cancellationToken).ConfigureAwait(false);
            var stageStatus = _staging.GetStatus(staged.Version)
                ?? throw new UpdateSecurityException("UPDATE_STAGE_MISSING", "Verified staged update disappeared before handoff.");
            var handoff = _handoff.Prepare(stageStatus, currentVersion, currentInstallRoot);
            var canonicalHandoff = _handoff.Read(handoff.PlanPath);
            transaction = _journal.Begin(canonicalHandoff);

            if (_candidatePreparationOverride is not null)
                await _candidatePreparationOverride(transaction, cancellationToken).ConfigureAwait(false);
            else
                await RunCandidatePreparationWorkerAsync(transaction, cancellationToken).ConfigureAwait(false);

            var canonicalTransaction = _journal.Read(transaction.JournalPath);
            if (!string.Equals(canonicalTransaction.State, "prepared", StringComparison.Ordinal))
                throw new UpdateSecurityException("UPDATE_PREPARATION_STATE_CHANGED", "Prepared transaction changed state while Candidate was being prepared.");

            var protocol = new UpdaterWorkerProtocol(_journal, _deploymentRoot);
            var planPath = Path.Combine(Path.GetDirectoryName(canonicalTransaction.JournalPath)!, "worker-plan.json");
            var workerPlan = protocol.Read(planPath, canonicalTransaction);
            var candidateStatePath = Path.Combine(workerPlan.CandidateRoot, "candidate-state.json");
            var candidate = new CandidatePackagePreparer().ReadAndVerify(workerPlan, candidateStatePath);

            return new PreparationResult(
                true,
                canonicalTransaction.TransactionId,
                currentVersion,
                verified.Version,
                channel,
                canonicalTransaction.JournalPath,
                workerPlan.PlanPath,
                candidate.StatePath,
                candidate.EntryPoint,
                verified.Sha256,
                verified.Size);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            FailPreparedTransaction(transaction, ex is UpdateSecurityException security ? security.Code : "UPDATE_PREPARATION_FAILED");
            throw;
        }
    }

    private async Task RunCandidatePreparationWorkerAsync(UpdateTransactionJournal.TransactionState transaction, CancellationToken cancellationToken)
    {
        if (!File.Exists(_updaterWorkerPath))
            throw new UpdateSecurityException("UPDATE_WORKER_MISSING", "Updater Worker executable is missing.");

        var start = new ProcessStartInfo
        {
            FileName = _updaterWorkerPath,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.ArgumentList.Add("prepare-candidate");
        start.ArgumentList.Add("--journal");
        start.ArgumentList.Add(transaction.JournalPath);
        start.ArgumentList.Add("--transactions-root");
        start.ArgumentList.Add(_transactionsRoot);
        start.ArgumentList.Add("--deployment-root");
        start.ArgumentList.Add(_deploymentRoot);

        using var process = Process.Start(start) ?? throw new UpdateSecurityException("UPDATE_WORKER_START_FAILED", "Updater Worker could not be started.");
        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        try { await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false); }
        catch (OperationCanceledException)
        {
            try { if (!process.HasExited) process.Kill(true); } catch { }
            throw;
        }
        var stdout = await stdoutTask.ConfigureAwait(false);
        var stderr = await stderrTask.ConfigureAwait(false);
        if (process.ExitCode != 0)
            throw new UpdateSecurityException("UPDATE_CANDIDATE_PREPARATION_FAILED", $"Updater Worker rejected Candidate preparation (exit {process.ExitCode}). {TrimDiagnostic(stderr)}");
        if (string.IsNullOrWhiteSpace(stdout))
            throw new UpdateSecurityException("UPDATE_CANDIDATE_PREPARATION_FAILED", "Updater Worker returned no Candidate preparation result.");
    }

    private void FailPreparedTransaction(UpdateTransactionJournal.TransactionState? transaction, string code)
    {
        if (transaction is null) return;
        try
        {
            var canonical = _journal.Read(transaction.JournalPath);
            if (string.Equals(canonical.State, "prepared", StringComparison.Ordinal))
                _journal.Transition(canonical, "failed", string.IsNullOrWhiteSpace(code) ? "UPDATE_PREPARATION_FAILED" : code);
        }
        catch { }
    }

    private static string TrimDiagnostic(string value)
    {
        var text = (value ?? string.Empty).Replace('\r', ' ').Replace('\n', ' ').Trim();
        return text.Length <= 240 ? text : text[..240];
    }

    internal sealed record PreparationResult(
        bool Ready,
        string TransactionId,
        Version CurrentVersion,
        Version TargetVersion,
        string Channel,
        string JournalPath,
        string WorkerPlanPath,
        string CandidateStatePath,
        string EntryPoint,
        string Sha256,
        long Size);
}

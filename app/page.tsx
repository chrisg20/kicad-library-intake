"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  Box,
  Check,
  CheckCircle2,
  CircleDotDashed,
  Cpu,
  FileBox,
  FileCode2,
  FileText,
  FolderGit2,
  GitFork,
  GitCommitHorizontal,
  Link2,
  Loader2,
  LockKeyhole,
  PackageCheck,
  PlugZap,
  UploadCloud,
  WandSparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { AssetPreviewGallery } from "@/components/asset-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import { downloadBrowserFile, inspectBrowserLink, type LinkCandidate, type LinkInspection } from "@/lib/browser-link";
import {
  commitPackage,
  parseRepository,
  testRepository,
  type RepositoryInfo,
} from "@/lib/github";
import {
  acceptedFileTypes,
  formatBytes,
  footprintSuffix,
  inferMetadataFromAssets,
  ingestBrowserFiles,
  normalizeAssets,
  sanitizeKiCadName,
  type AssetKind,
  type IntakeAsset,
  type NormalizedPackage,
  type PartMetadata,
} from "@/lib/kicad";

const defaultMetadata: PartMetadata = {
  manufacturer: "",
  mpn: "",
  libraryName: "",
  packageName: "",
  category: "RF",
  datasheet: "",
  description: "",
  verified: "Unverified",
  sourceUrl: "",
};

const kindLabels: Record<AssetKind | "metadata", string> = {
  symbol: "Symbol",
  footprint: "Footprint",
  model: "3D model",
  datasheet: "Datasheet",
  "legacy-symbol": "Legacy symbol",
  unsupported: "Unsupported",
  metadata: "Manifest",
};

function AssetIcon({ kind, className = "size-4" }: { kind: AssetKind | "metadata"; className?: string }) {
  if (kind === "symbol") return <FileCode2 className={className} />;
  if (kind === "footprint") return <FileBox className={className} />;
  if (kind === "model") return <Box className={className} />;
  if (kind === "datasheet") return <FileText className={className} />;
  if (kind === "metadata") return <PackageCheck className={className} />;
  return <AlertTriangle className={className} />;
}

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-2 block text-sm font-medium text-slate-300">
      {children}
    </label>
  );
}

function Step({ number, label, active }: { number: number; label: string; active: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 ${active ? "text-slate-100" : "text-slate-500"}`}>
      <span
        className={`grid size-7 place-items-center rounded-full border font-mono text-xs font-semibold ${
          active ? "border-teal-400/60 bg-teal-400/10 text-teal-300" : "border-slate-700 bg-slate-900"
        }`}
      >
        {number}
      </span>
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState<IntakeAsset[]>([]);
  const [metadata, setMetadata] = useState<PartMetadata>(defaultMetadata);
  const [sourceUrl, setSourceUrl] = useState("");
  const [inspection, setInspection] = useState<LinkInspection | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [normalizeBusy, setNormalizeBusy] = useState(false);
  const [normalized, setNormalized] = useState<NormalizedPackage | null>(null);
  const [repositoryInput, setRepositoryInput] = useState("");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [repositoryInfo, setRepositoryInfo] = useState<RepositoryInfo | null>(null);
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitResult, setCommitResult] = useState<{
    sha: string;
    shortSha: string;
    url: string;
    filesChanged: number;
  } | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const savedRepository = window.localStorage.getItem("kicad-intake-repository");
      const savedBranch = window.localStorage.getItem("kicad-intake-branch");
      if (savedRepository) setRepositoryInput(savedRepository);
      if (savedBranch) setBranch(savedBranch);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const supportedCount = assets.filter(
    (asset) => asset.kind !== "unsupported" && asset.kind !== "legacy-symbol",
  ).length;
  const packageRequired = assets.some((asset) => asset.kind === "footprint" || asset.kind === "model");
  const currentStep = normalized ? 3 : assets.length || sourceUrl ? 2 : 1;
  const commitMessage = `Add ${metadata.libraryName || metadata.mpn || "component"} KiCad library assets`;
  const previewLibraryName = sanitizeKiCadName(metadata.libraryName, "Part_Name");
  const previewPackageName = sanitizeKiCadName(metadata.packageName, "Package");

  const targetSummary = useMemo(() => {
    if (!normalized) return [];
    return [...new Set(normalized.files.map((file) => file.outputPath))];
  }, [normalized]);

  function updateMetadata<Key extends keyof PartMetadata>(key: Key, value: PartMetadata[Key]) {
    setMetadata((current) => ({ ...current, [key]: value }));
    setNormalized(null);
    setCommitResult(null);
  }

  async function addBrowserFiles(files: File[]) {
    if (!files.length) return;
    try {
      const incoming = await ingestBrowserFiles(files);
      setAssets((current) => {
        const combined = [...current, ...incoming];
        const inferred = inferMetadataFromAssets(combined);
        setMetadata((previous) => ({
          ...previous,
          manufacturer: previous.manufacturer || inferred.manufacturer || "",
          mpn: previous.mpn || inferred.mpn || "",
          libraryName: previous.libraryName || inferred.libraryName || "",
          packageName: previous.packageName || inferred.packageName || "",
          datasheet: previous.datasheet || inferred.datasheet || "",
          description: previous.description || inferred.description || "",
        }));
        return combined;
      });
      setNormalized(null);
      setCommitResult(null);
      toast.success(`${incoming.length} asset${incoming.length === 1 ? "" : "s"} added`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Those files could not be read.");
    }
  }

  function removeAsset(id: string) {
    setAssets((current) => current.filter((asset) => asset.id !== id));
    setNormalized(null);
    setCommitResult(null);
  }

  function updateFootprint(id: string, patch: Partial<IntakeAsset>) {
    setAssets((current) => current.map((asset) => asset.id === id ? { ...asset, ...patch } : asset));
    setNormalized(null);
    setCommitResult(null);
  }

  async function fetchCandidate(candidate: LinkCandidate | { name: string; url: string; kind: "download" }) {
    setLinkBusy(true);
    try {
      const file = await downloadBrowserFile(candidate);
      await addBrowserFiles([new File([file.bytes], file.filename || candidate.name, { type: file.contentType })]);
      updateMetadata("sourceUrl", file.sourceUrl);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The linked file could not be downloaded.");
    } finally {
      setLinkBusy(false);
    }
  }

  async function inspectLink() {
    if (!sourceUrl.trim()) return toast.error("Paste a component or CAD file link first.");
    setLinkBusy(true);
    setInspection(null);
    try {
      const payload = await inspectBrowserLink(sourceUrl.trim());
      updateMetadata("sourceUrl", payload.sourceUrl);
      if (payload.kind === "file") {
        await addBrowserFiles([new File([payload.bytes], payload.filename, { type: payload.contentType })]);
        return;
      }
      setInspection(payload);
      setMetadata((current) => ({
        ...current,
        manufacturer: current.manufacturer || payload.metadata.manufacturer || "",
        mpn: current.mpn || payload.metadata.mpn || "",
        libraryName: current.libraryName || payload.metadata.libraryName || payload.metadata.mpn || "",
        description: current.description || payload.metadata.description || "",
        datasheet: current.datasheet || payload.metadata.datasheet || "",
        sourceUrl: payload.sourceUrl,
      }));
      if (!payload.candidates.length) {
        toast.info("Metadata found, but no public CAD download was exposed on that page.");
      } else {
        toast.success(`${payload.candidates.length} possible download${payload.candidates.length === 1 ? "" : "s"} found`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The link could not be inspected.");
    } finally {
      setLinkBusy(false);
    }
  }

  async function runNormalization() {
    setNormalizeBusy(true);
    try {
      const result = await normalizeAssets(assets, metadata);
      setNormalized(result);
      setCommitResult(null);
      toast.success("Package normalized and ready for review");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The package could not be normalized.");
    } finally {
      setNormalizeBusy(false);
    }
  }

  async function connectRepository() {
    setConnectionBusy(true);
    try {
      const { owner, repo } = parseRepository(repositoryInput);
      const info = await testRepository({ owner, repo, branch, token });
      setRepositoryInfo(info);
      setBranch(info.branch);
      window.localStorage.setItem("kicad-intake-repository", info.fullName);
      window.localStorage.setItem("kicad-intake-branch", info.branch);
      setRepositoryInput(info.fullName);
      setRepoDialogOpen(false);
      toast.success(`Connected to ${info.fullName}`);
    } catch (error) {
      setRepositoryInfo(null);
      toast.error(error instanceof Error ? error.message : "The repository could not be connected.");
    } finally {
      setConnectionBusy(false);
    }
  }

  async function commitToRepository() {
    if (!normalized || !repositoryInfo) return;
    setCommitBusy(true);
    try {
      const { owner, repo } = parseRepository(repositoryInput);
      const result = await commitPackage(
        { owner, repo, branch: repositoryInfo.branch, token },
        normalized.files,
        commitMessage,
      );
      setCommitResult(result);
      toast.success(`Committed ${result.filesChanged} files at ${result.shortSha}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The commit could not be created.");
    } finally {
      setCommitBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--background)] text-slate-100">
      <Toaster theme="dark" position="bottom-right" richColors />

      <header className="border-b border-slate-800/90 bg-[#090d13]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1480px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="relative grid size-9 place-items-center rounded-lg border border-teal-400/35 bg-teal-400/10 text-teal-300 shadow-[0_0_24px_rgba(45,212,191,0.12)]">
              <Cpu className="size-5" />
              <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-[#090d13] bg-emerald-400" />
            </div>
            <div>
              <div className="text-[15px] font-semibold tracking-tight text-slate-100">KiCad Library Intake</div>
              <div className="font-mono text-[11px] tracking-wide text-slate-500">NORMALIZE · REVIEW · COMMIT</div>
            </div>
          </div>

          <Dialog open={repoDialogOpen} onOpenChange={setRepoDialogOpen}>
            <DialogTrigger asChild>
              <Button
                variant="outline"
                className="h-9 border-slate-700 bg-slate-900/70 text-slate-200 hover:bg-slate-800 hover:text-white"
              >
                {repositoryInfo ? <CheckCircle2 className="text-emerald-400" /> : <GitFork />}
                <span className="hidden sm:inline">
                  {repositoryInfo ? `${repositoryInfo.fullName} · ${repositoryInfo.branch}` : "Connect repository"}
                </span>
                <span className="sm:hidden">Repository</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="border-slate-700 bg-[#0d131c] text-slate-100 shadow-2xl sm:max-w-xl">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-xl">
                  <FolderGit2 className="size-5 text-teal-300" />
                  Connect the Git library
                </DialogTitle>
                <DialogDescription className="leading-6 text-slate-400">
                  Use a fine-grained token with Contents read/write access to one repository. The token stays in memory and is cleared when this tab closes.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-5 py-2">
                <div>
                  <FieldLabel htmlFor="repository">GitHub repository</FieldLabel>
                  <Input
                    id="repository"
                    value={repositoryInput}
                    onChange={(event) => {
                      setRepositoryInput(event.target.value);
                      setRepositoryInfo(null);
                    }}
                    placeholder="owner/KiCad-Library"
                    className="h-10 border-slate-700 bg-slate-950/70 text-slate-100 placeholder:text-slate-600"
                  />
                </div>
                <div className="grid gap-5 sm:grid-cols-[0.7fr_1.3fr]">
                  <div>
                    <FieldLabel htmlFor="branch">Branch</FieldLabel>
                    <Input
                      id="branch"
                      value={branch}
                      onChange={(event) => {
                        setBranch(event.target.value);
                        setRepositoryInfo(null);
                      }}
                      placeholder="main"
                      className="h-10 border-slate-700 bg-slate-950/70 text-slate-100"
                    />
                  </div>
                  <div>
                    <FieldLabel htmlFor="token">Fine-grained token</FieldLabel>
                    <Input
                      id="token"
                      type="password"
                      autoComplete="off"
                      value={token}
                      onChange={(event) => {
                        setToken(event.target.value);
                        setRepositoryInfo(null);
                      }}
                      placeholder="github_pat_…"
                      className="h-10 border-slate-700 bg-slate-950/70 font-mono text-slate-100 placeholder:text-slate-600"
                    />
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-sm leading-5 text-slate-400">
                  <LockKeyhole className="mt-0.5 size-4 shrink-0 text-slate-500" />
                  Repository name and branch are remembered on this device. The token is never written to browser storage.
                </div>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setRepoDialogOpen(false)} className="text-slate-400 hover:bg-slate-800 hover:text-slate-100">
                  Cancel
                </Button>
                <Button onClick={connectRepository} disabled={connectionBusy} className="bg-teal-300 text-slate-950 hover:bg-teal-200">
                  {connectionBusy ? <Loader2 className="animate-spin" /> : <PlugZap />}
                  Test and connect
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <div className="mx-auto max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <section className="mb-6 flex flex-col gap-5 border-b border-slate-800/80 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="mb-2 font-mono text-xs font-medium uppercase tracking-[0.18em] text-teal-300/80">Component intake</p>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50 sm:text-3xl">Turn downloaded CAD into a trusted library part.</h1>
            <p className="mt-2 max-w-2xl text-base leading-7 text-slate-400">
              Add downloaded KiCad assets, a datasheet, or a direct public link. Names, model references, repository paths, and traceability metadata are normalized together in your browser.
            </p>
          </div>
          <div className="flex items-center gap-3 sm:gap-5">
            <Step number={1} label="Source" active={currentStep >= 1} />
            <ArrowRight className="size-4 text-slate-700" />
            <Step number={2} label="Normalize" active={currentStep >= 2} />
            <ArrowRight className="size-4 text-slate-700" />
            <Step number={3} label="Commit" active={currentStep >= 3} />
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.18fr)_minmax(360px,0.82fr)]">
          <div className="left-stack">
            <section className="panel overflow-hidden">
              <div className="panel-heading">
                <div>
                  <span className="panel-kicker">01 / SOURCE</span>
                  <h2 className="panel-title">Add component assets</h2>
                </div>
                {assets.length > 0 && (
                  <Badge variant="outline" className="border-slate-700 bg-slate-900 text-slate-300">
                    {supportedCount}/{assets.length} supported
                  </Badge>
                )}
              </div>

              <div className="p-5 sm:p-6">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Link2 className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500" />
                    <Input
                      value={sourceUrl}
                      onChange={(event) => {
                        setSourceUrl(event.target.value);
                        setInspection(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void inspectLink();
                      }}
                      placeholder="Paste a component page, CAD file, or ZIP link"
                      aria-label="Component or CAD file URL"
                      className="h-11 border-slate-700 bg-slate-950/70 pl-10 text-base text-slate-100 placeholder:text-slate-600 md:text-sm"
                    />
                  </div>
                  <Button
                    onClick={inspectLink}
                    disabled={linkBusy || !sourceUrl.trim()}
                    className="h-11 bg-slate-100 px-5 text-slate-950 hover:bg-white"
                  >
                    {linkBusy ? <Loader2 className="animate-spin" /> : <WandSparkles />}
                    Inspect
                  </Button>
                </div>
                <p className="mt-2 text-sm text-slate-500">
                  Pages-only mode: links work when the source permits direct browser access. If one is blocked, download it and drop the file below.
                </p>

                {inspection && (
                  <div className="mt-4 rounded-xl border border-slate-700/80 bg-slate-950/55 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-200">{inspection.title || "Component page"}</div>
                        <div className="mt-1 font-mono text-xs text-slate-600">{new URL(inspection.sourceUrl).hostname}</div>
                      </div>
                      <Badge variant="outline" className="shrink-0 border-teal-400/25 bg-teal-400/5 text-teal-300">
                        {inspection.candidates.length} found
                      </Badge>
                    </div>
                    {inspection.candidates.length > 0 ? (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {inspection.candidates.map((candidate) => (
                          <button
                            key={candidate.url}
                            type="button"
                            onClick={() => void fetchCandidate(candidate)}
                            disabled={linkBusy}
                            className="group flex min-w-0 items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2.5 text-left transition hover:border-teal-400/30 hover:bg-slate-800/80 disabled:opacity-50"
                          >
                            {candidate.kind === "archive" ? <Archive className="size-4 shrink-0 text-amber-300" /> : <AssetIcon kind={candidate.kind === "download" ? "unsupported" : candidate.kind} className="size-4 shrink-0 text-teal-300" />}
                            <span className="min-w-0 flex-1 truncate text-sm text-slate-300">{candidate.name}</span>
                            <span className="font-mono text-[10px] uppercase text-slate-600 group-hover:text-teal-400">ADD</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-3 flex items-center gap-2 text-sm text-amber-200/80">
                        <AlertTriangle className="size-4" />
                        No public CAD download was visible. Drop the downloaded files below.
                      </div>
                    )}
                  </div>
                )}

                <div className="my-5 flex items-center gap-3 text-xs font-medium uppercase tracking-[0.16em] text-slate-700">
                  <span className="h-px flex-1 bg-slate-800" />
                  or drop files
                  <span className="h-px flex-1 bg-slate-800" />
                </div>

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    if (event.currentTarget === event.target) setIsDragging(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setIsDragging(false);
                    void addBrowserFiles(Array.from(event.dataTransfer.files));
                  }}
                  className={`group relative flex min-h-36 w-full flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed px-6 py-7 text-center transition ${
                    isDragging
                      ? "border-teal-300 bg-teal-300/8 shadow-[inset_0_0_50px_rgba(45,212,191,0.06)]"
                      : "border-slate-700 bg-[#0b1119] hover:border-slate-600 hover:bg-slate-900/70"
                  }`}
                >
                  <span className="mb-3 grid size-11 place-items-center rounded-xl border border-slate-700 bg-slate-900 text-slate-400 transition group-hover:border-teal-400/30 group-hover:text-teal-300">
                    <UploadCloud className="size-5" />
                  </span>
                  <span className="text-sm font-medium text-slate-200">Drop a package or choose files</span>
                  <span className="mt-1 text-sm text-slate-500">KiCad symbols, footprints, STEP/IGES/VRML models, PDF datasheets, or ZIP · 40 MB max</span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={acceptedFileTypes}
                  className="hidden"
                  onChange={(event) => {
                    void addBrowserFiles(Array.from(event.target.files ?? []));
                    event.currentTarget.value = "";
                  }}
                />

                {assets.length > 0 && (
                  <div className="mt-5 overflow-hidden rounded-xl border border-slate-800">
                    {assets.map((asset, index) => (
                      <div
                        key={asset.id}
                        className={`flex items-center gap-3 bg-slate-950/45 px-3.5 py-3 ${index ? "border-t border-slate-800" : ""}`}
                      >
                        <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${asset.kind === "unsupported" || asset.kind === "legacy-symbol" ? "bg-amber-400/10 text-amber-300" : "bg-teal-400/8 text-teal-300"}`}>
                          <AssetIcon kind={asset.kind} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-slate-300">{asset.name}</div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-600">
                            <span>{kindLabels[asset.kind]}</span>
                            <span>·</span>
                            <span>{formatBytes(asset.bytes.byteLength)}</span>
                          </div>
                        </div>
                        {asset.warnings.length > 0 && <AlertTriangle className="size-4 shrink-0 text-amber-300" aria-label={asset.warnings[0]} />}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => removeAsset(asset.id)}
                          className="text-slate-600 hover:bg-slate-800 hover:text-slate-200"
                          aria-label={`Remove ${asset.name}`}
                        >
                          <X />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <AssetPreviewGallery assets={assets} />
                {assets.some((asset) => asset.kind === "footprint") && (
                  <div className="mt-5 space-y-4 rounded-xl border border-slate-800 p-4">
                    <h3 className="text-sm font-medium text-slate-200">Footprint variants</h3>
                    <p className="text-sm text-slate-500">Add as many footprints as needed. Each gets its own file; choose which one the symbol uses by default.</p>
                    <FieldLabel htmlFor="default-footprint">Default symbol footprint</FieldLabel>
                    <Select value={metadata.primaryFootprintId && assets.some((a) => a.id === metadata.primaryFootprintId) ? metadata.primaryFootprintId : assets.find((a) => a.kind === "footprint")?.id}
                      onValueChange={(value) => updateMetadata("primaryFootprintId", value ?? "")}>
                      <SelectTrigger id="default-footprint" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>{assets.filter((a) => a.kind === "footprint").map((a) => <SelectItem key={a.id} value={a.id}>{a.sourceName}</SelectItem>)}</SelectContent>
                    </Select>
                    {assets.filter((a) => a.kind === "footprint").map((asset) => (
                      <div key={asset.id} className="space-y-2 border-t border-slate-800 pt-3">
                        <p className="break-all text-sm text-slate-400">{asset.sourceName}</p>
                        <FieldLabel htmlFor={`suffix-${asset.id}`}>Footprint name suffix</FieldLabel>
                        <Input id={`suffix-${asset.id}`} value={asset.footprintSuffix ?? ""}
                          placeholder={assets.filter((a) => a.kind === "footprint").length === 1 ? metadata.packageName || footprintSuffix(asset) : footprintSuffix(asset)}
                          onChange={(event) => updateFootprint(asset.id, { footprintSuffix: event.target.value })} />
                        <FieldLabel htmlFor={`model-${asset.id}`}>3D model for this footprint</FieldLabel>
                        <Select value={asset.modelAssetId ?? "auto"} onValueChange={(value) => updateFootprint(asset.id, { modelAssetId: value === "auto" ? undefined : value ?? "none" })}>
                          <SelectTrigger id={`model-${asset.id}`} className="w-full"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Automatic (only when one model is included)</SelectItem>
                            <SelectItem value="none">No imported model</SelectItem>
                            {assets.filter((a) => a.kind === "model").map((a) => <SelectItem key={a.id} value={a.id}>{a.sourceName}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="review-panel panel overflow-hidden">
              <div className="panel-heading">
                <div>
                  <span className="panel-kicker">03 / REVIEW</span>
                  <h2 className="panel-title">Repository change set</h2>
                </div>
                {normalized && (
                  <Badge variant="outline" className="border-emerald-400/25 bg-emerald-400/5 text-emerald-300">
                    <Check className="size-3" /> Ready to commit
                  </Badge>
                )}
              </div>

              {!normalized ? (
                <div className="grid min-h-64 place-items-center p-8 text-center">
                  <div>
                    <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-slate-800 bg-slate-950/60 text-slate-600">
                      <CircleDotDashed className="size-6" />
                    </div>
                    <h3 className="mt-4 text-base font-medium text-slate-300">No change set yet</h3>
                    <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-slate-500">
                      Add assets, confirm the component identity, then run normalization to preview every repository path.
                    </p>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="grid gap-4 border-b border-slate-800 p-5 sm:grid-cols-[1fr_auto] sm:items-center sm:p-6">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-semibold text-slate-100">{normalized.componentName}</h3>
                        <Badge variant="secondary" className="bg-slate-800 text-slate-300">{metadata.category}</Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-slate-500">
                        <span>{targetSummary.length} repository files</span>
                        <span>{normalized.symbolName ? `symbol ${normalized.symbolName}` : "no symbol"}</span>
                        <span>{normalized.footprintNames.length} footprint{normalized.footprintNames.length === 1 ? "" : "s"}</span>
                      </div>
                    </div>
                    <div className="min-w-48">
                      <div className="mb-2 flex items-center justify-between text-xs">
                        <span className="text-slate-500">Package completeness</span>
                        <span className="font-mono font-semibold text-teal-300">{normalized.completeness}%</span>
                      </div>
                      <Progress value={normalized.completeness} className="h-1.5 bg-slate-800 [&_[data-slot=progress-indicator]]:bg-teal-300" />
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-left">
                      <thead className="border-b border-slate-800 bg-slate-950/40 font-mono text-[11px] uppercase tracking-[0.12em] text-slate-600">
                        <tr>
                          <th className="px-5 py-3 font-medium sm:px-6">Asset</th>
                          <th className="px-4 py-3 font-medium">Source</th>
                          <th className="px-4 py-3 font-medium">Repository path</th>
                          <th className="px-5 py-3 text-right font-medium sm:px-6">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/80">
                        {normalized.files.map((file) => (
                          <tr key={`${file.id}-${file.outputPath}`} className="bg-slate-950/20">
                            <td className="px-5 py-3.5 sm:px-6">
                              <div className="flex items-center gap-2 text-sm text-slate-300">
                                <AssetIcon kind={file.kind} className="size-4 text-teal-300" />
                                {kindLabels[file.kind]}
                              </div>
                            </td>
                            <td className="max-w-48 truncate px-4 py-3.5 text-sm text-slate-500">{file.inputName}</td>
                            <td className="px-4 py-3.5 font-mono text-xs text-slate-300">{file.outputPath}</td>
                            <td className="px-5 py-3.5 text-right sm:px-6">
                              <Badge variant="outline" className={file.strategy === "merge-symbol-library" ? "border-cyan-400/20 bg-cyan-400/5 text-cyan-300" : "border-slate-700 bg-slate-900 text-slate-400"}>
                                {file.strategy === "merge-symbol-library" ? "merge" : "add / replace"}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {normalized.warnings.length > 0 && (
                    <div className="border-t border-slate-800 bg-amber-400/[0.025] p-5 sm:p-6">
                      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-amber-200">
                        <AlertTriangle className="size-4" />
                        Review before commit
                      </div>
                      <ul className="grid gap-2 text-sm leading-5 text-slate-400">
                        {normalized.warnings.map((warning) => (
                          <li key={warning} className="flex gap-2">
                            <span className="mt-2 size-1 shrink-0 rounded-full bg-amber-300/70" />
                            {warning}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>

          <aside className="order-2 space-y-6">
            <section className="panel overflow-hidden xl:sticky xl:top-6">
              <div className="panel-heading">
                <div>
                  <span className="panel-kicker">02 / NORMALIZE</span>
                  <h2 className="panel-title">Component identity</h2>
                </div>
                <Cpu className="size-5 text-slate-600" />
              </div>
              <div className="grid gap-5 p-5 sm:p-6">
                <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                  <div>
                    <FieldLabel htmlFor="manufacturer">Manufacturer</FieldLabel>
                    <Input
                      id="manufacturer"
                      value={metadata.manufacturer}
                      onChange={(event) => updateMetadata("manufacturer", event.target.value)}
                      placeholder="Analog Devices"
                      className="field-input"
                    />
                  </div>
                  <div>
                    <FieldLabel htmlFor="mpn">Manufacturer part number <span className="text-teal-300">*</span></FieldLabel>
                    <Input
                      id="mpn"
                      value={metadata.mpn}
                      onChange={(event) => updateMetadata("mpn", event.target.value)}
                      placeholder="ADL5606ARKZ-R7"
                      className="field-input font-mono"
                    />
                  </div>
                </div>

                <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                  <div>
                    <FieldLabel htmlFor="library-name">KiCad library name <span className="text-teal-300">*</span></FieldLabel>
                    <Input
                      id="library-name"
                      value={metadata.libraryName}
                      onChange={(event) => updateMetadata("libraryName", event.target.value)}
                      placeholder="ADL5606"
                      className="field-input font-mono"
                    />
                  </div>
                  <div>
                    <FieldLabel htmlFor="package">Package / footprint suffix {packageRequired && <span className="text-teal-300">*</span>}</FieldLabel>
                    <Input
                      id="package"
                      value={metadata.packageName}
                      onChange={(event) => updateMetadata("packageName", event.target.value)}
                      placeholder="SOT-89-3"
                      className="field-input font-mono"
                    />
                  </div>
                </div>

                <div>
                  <FieldLabel htmlFor="description">Description</FieldLabel>
                  <textarea
                    id="description"
                    value={metadata.description}
                    onChange={(event) => updateMetadata("description", event.target.value)}
                    placeholder="20 MHz to 4.5 GHz RF gain block"
                    rows={3}
                    className="w-full resize-none rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-base leading-6 text-slate-100 shadow-xs outline-none transition placeholder:text-slate-600 focus:border-teal-400/60 focus:ring-3 focus:ring-teal-400/10 md:text-sm"
                  />
                </div>

                <div>
                  <FieldLabel htmlFor="datasheet">Datasheet URL <span className="font-normal text-slate-500">(optional when a PDF is attached)</span></FieldLabel>
                  <Input
                    id="datasheet"
                    value={metadata.datasheet}
                    onChange={(event) => updateMetadata("datasheet", event.target.value)}
                    placeholder="https://manufacturer.com/datasheet.pdf"
                    className="field-input"
                  />
                </div>

                <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                  <div>
                    <FieldLabel>Library category</FieldLabel>
                    <Select value={metadata.category} onValueChange={(value) => updateMetadata("category", value as PartMetadata["category"])}>
                      <SelectTrigger className="h-10 w-full border-slate-700 bg-slate-950/70 text-slate-100">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-slate-700 bg-slate-900 text-slate-100">
                        <SelectItem value="RF">RF</SelectItem>
                        <SelectItem value="Custom">Custom</SelectItem>
                        <SelectItem value="Modules">Modules</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <FieldLabel>Verification state</FieldLabel>
                    <Select value={metadata.verified} onValueChange={(value) => updateMetadata("verified", value as PartMetadata["verified"])}>
                      <SelectTrigger className="h-10 w-full border-slate-700 bg-slate-950/70 text-slate-100">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-slate-700 bg-slate-900 text-slate-100">
                        <SelectItem value="Unverified">Unverified</SelectItem>
                        <SelectItem value="Datasheet checked">Datasheet checked</SelectItem>
                        <SelectItem value="Fabricated">Fabricated</SelectItem>
                        <SelectItem value="Electrically tested">Electrically tested</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950/45 p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-sm font-medium text-slate-300">Naming preview</div>
                    <Badge variant="outline" className="border-slate-700 text-slate-500">KLC-style</Badge>
                  </div>
                  <div className="mt-3 grid gap-2 font-mono text-xs">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-16 shrink-0 text-slate-600">SYMBOL</span>
                      <span className="truncate text-teal-300">{metadata.category}:{previewLibraryName}</span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-16 shrink-0 text-slate-600">FOOTPRINT</span>
                      <span className="truncate text-slate-400">{metadata.category}:{previewLibraryName}_{previewPackageName}</span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-16 shrink-0 text-slate-600">3D</span>
                      <span className="truncate text-slate-400">same stem as footprint</span>
                    </div>
                  </div>
                </div>

                <Button
                  onClick={runNormalization}
                  disabled={normalizeBusy || !metadata.mpn.trim() || !metadata.libraryName.trim() || (packageRequired && !metadata.packageName.trim()) || supportedCount === 0}
                  className="h-11 bg-teal-300 text-slate-950 shadow-[0_8px_30px_rgba(45,212,191,0.12)] hover:bg-teal-200"
                >
                  {normalizeBusy ? <Loader2 className="animate-spin" /> : <WandSparkles />}
                  Normalize and preview
                </Button>

                <div className="h-px bg-slate-800" />

                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-slate-300">Commit package</div>
                      <div className="mt-1 text-xs text-slate-600">One atomic Git commit</div>
                    </div>
                    {repositoryInfo ? (
                      <Badge variant="outline" className="border-emerald-400/20 bg-emerald-400/5 text-emerald-300">Connected</Badge>
                    ) : (
                      <Badge variant="outline" className="border-slate-700 text-slate-500">Not connected</Badge>
                    )}
                  </div>

                  {commitResult ? (
                    <a
                      href={commitResult.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-3 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] p-4 transition hover:bg-emerald-400/10"
                    >
                      <span className="grid size-9 place-items-center rounded-lg bg-emerald-400/10 text-emerald-300"><CheckCircle2 className="size-5" /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-emerald-200">Committed successfully</span>
                        <span className="mt-0.5 block font-mono text-xs text-emerald-300/60">{commitResult.shortSha} · {commitResult.filesChanged} files</span>
                      </span>
                      <ArrowRight className="size-4 text-emerald-300" />
                    </a>
                  ) : (
                    <Button
                      onClick={repositoryInfo ? commitToRepository : () => setRepoDialogOpen(true)}
                      disabled={commitBusy || !normalized}
                      variant="outline"
                      className="h-11 w-full border-slate-700 bg-slate-900/70 text-slate-200 hover:border-slate-600 hover:bg-slate-800 hover:text-white"
                    >
                      {commitBusy ? <Loader2 className="animate-spin" /> : repositoryInfo ? <GitCommitHorizontal /> : <GitFork />}
                      {repositoryInfo ? `Commit to ${repositoryInfo.branch}` : "Connect repository to commit"}
                    </Button>
                  )}
                  {normalized && !commitResult && (
                    <p className="mt-2 truncate text-center font-mono text-[11px] text-slate-600">{commitMessage}</p>
                  )}
                </div>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}

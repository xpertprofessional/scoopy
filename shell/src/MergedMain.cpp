// The app's ENTRY POINT, and nothing else. The shell itself is MergedApp.{h,cpp}
// — see that header for why the assembly is a library with two entry points
// (this one, and shell/tools/merged_walk.cpp).
#include "MergedApp.h"

#include <cstring>

#if SCOOPY_PLUGIN_HOST
 #include "NativePluginHost.hpp" // runPluginScanWorker — the --scan-plugin child entry
#endif

namespace {
/** The app's own subclass exists only to be the thing START_JUCE_APPLICATION
    names. It adds nothing: the app is the walk, minus the walk. */
class WizardMergedApplication final : public wizard::merged::MergedApplication {};
} // namespace

// START_JUCE_APPLICATION, opened one notch (P6-1): the out-of-process plugin
// scan runs BEFORE any application object exists. NativePluginHost's scanner
// re-launches this same binary with `--scan-plugin <format> <id>`; the child
// instantiates that one plugin and prints its descriptions as XML on stdout, so
// a plugin that crashes on instantiation kills only the throwaway child while
// the parent records an empty result and scans on. Everything after the
// intercept is the macro's own expansion, verbatim.
JUCE_CREATE_APPLICATION_DEFINE(WizardMergedApplication)
JUCE_MAIN_FUNCTION
{
#if SCOOPY_PLUGIN_HOST
    if (argc >= 4 && std::strcmp(argv[1], "--scan-plugin") == 0)
        return scoopyloops::runPluginScanWorker(argv[2], argv[3]);
#endif
    juce::JUCEApplicationBase::createInstance = &juce_CreateApplication;
    return juce::JUCEApplicationBase::main(JUCE_MAIN_FUNCTION_ARGS);
}

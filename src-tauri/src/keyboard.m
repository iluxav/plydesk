// Native desktop input only. No remote connection or plugin execution lives here.
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>

typedef void (*ShortcutCallback)(const char *);
static ShortcutCallback notifyShortcut;
static __weak NSWindow *desktopWindow;
static NSDictionary *configuration;
static id localMonitor;
static id resignObserver;
static CFMachPortRef eventTap;
static CFRunLoopSourceRef tapSource;
static NSMutableIndexSet *consumedKeys;

static unsigned modifiers(NSEventModifierFlags flags) {
    return ((flags & NSEventModifierFlagShift) ? 1 : 0)
        | ((flags & NSEventModifierFlagControl) ? 2 : 0)
        | ((flags & NSEventModifierFlagOption) ? 4 : 0)
        | ((flags & NSEventModifierFlagCommand) ? 8 : 0);
}
static void emitShortcut(NSString *action, unsigned code, unsigned mods, BOOL repeat) {
    if (!notifyShortcut) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{
        @"action": action, @"code": @(code), @"modifiers": @(mods), @"repeat": @(repeat)
    } options:0 error:nil];
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    notifyShortcut(json.UTF8String);
}
static BOOL focused(void) {
    return configuration && [configuration[@"enabled"] boolValue]
        && NSApp.isActive && NSApp.keyWindow == desktopWindow && !desktopWindow.attachedSheet;
}
static BOOL handle(NSEventType type, unsigned code, unsigned mods, BOOL repeat) {
    if (!focused()) { [consumedKeys removeAllIndexes]; return NO; }
    if (type == NSEventTypeFlagsChanged) {
        // Releases may arrive before the web UI has acknowledged the first
        // switch press. Always forward modifier state while this app is focused.
        emitShortcut(@"modifiers", code, mods, NO);
        return NO;
    }
    if (type == NSEventTypeKeyUp) {
        BOOL consumed = [consumedKeys containsIndex:code];
        [consumedKeys removeIndex:code];
        return consumed;
    }
    if (type != NSEventTypeKeyDown) return NO;
    if ((mods == 8 && code == 12) || (mods == 12 && code == 53)) return NO;
    NSString *action = nil;
    if ([configuration[@"recording"] boolValue]) {
        if (code == 53) action = @"cancel-recording";
        else if (mods & 14) action = @"record";
    } else if ([configuration[@"switching"] boolValue] && code == 53) action = @"cancel-switch";
    else if ([configuration[@"switching"] boolValue] && code == 36) action = @"commit-switch";
    else for (NSDictionary *binding in configuration[@"bindings"]) {
        if ([binding[@"code"] unsignedIntValue] == code && [binding[@"modifiers"] unsignedIntValue] == mods) {
            action = binding[@"action"];
            break;
        }
    }
    if (!action) return NO;
    [consumedKeys addIndex:code];
    emitShortcut(action, code, mods, repeat);
    return YES;
}
static CGEventRef tapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
    (void)proxy; (void)info;
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        // Fail open if macOS disables interception. The local monitor still works.
        emitShortcut(@"capture-disabled", 0, 0, NO);
        return event;
    }
    // Check focus before examining keyboard input from a session-level tap.
    if (!focused()) return event;
    NSEventType nativeType = type == kCGEventKeyDown ? NSEventTypeKeyDown
        : type == kCGEventKeyUp ? NSEventTypeKeyUp : NSEventTypeFlagsChanged;
    unsigned code = (unsigned)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    BOOL repeat = CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) != 0;
    return handle(nativeType, code, modifiers((NSEventModifierFlags)CGEventGetFlags(event)), repeat) ? NULL : event;
}
static void stopTap(void) {
    if (!eventTap) return;
    CGEventTapEnable(eventTap, false);
    CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, kCFRunLoopCommonModes);
    CFMachPortInvalidate(eventTap);
    CFRelease(tapSource);
    CFRelease(eventTap);
    tapSource = NULL; eventTap = NULL;
}

// Called exclusively on the AppKit main thread. The permission prompt is only
// requested by the user's explicit Settings action, never on startup or focus.
bool sshdesk_keyboard_configure(void *window, const char *json, ShortcutCallback callback) {
    desktopWindow = (__bridge NSWindow *)window;
    configuration = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json]
        dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    notifyShortcut = callback;
    if (!localMonitor) {
        consumedKeys = [NSMutableIndexSet indexSet];
        localMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:
            NSEventMaskKeyDown | NSEventMaskKeyUp | NSEventMaskFlagsChanged handler:^NSEvent *(NSEvent *event) {
                // Events consumed by the tap never reach here. Do not send the
                // same modifier release twice while the tap is active.
                if (event.type == NSEventTypeFlagsChanged && eventTap && CGEventTapIsEnabled(eventTap)) return event;
                return handle(event.type, event.keyCode, modifiers(event.modifierFlags), event.type == NSEventTypeKeyDown && event.isARepeat) ? nil : event;
            }];
        resignObserver = [[NSNotificationCenter defaultCenter] addObserverForName:NSApplicationDidResignActiveNotification
            object:nil queue:nil usingBlock:^(NSNotification *note) {
                (void)note;
                [consumedKeys removeAllIndexes]; emitShortcut(@"blur", 0, 0, NO);
            }];
    }
    BOOL wantsTap = [configuration[@"captureSystem"] boolValue] && [configuration[@"enabled"] boolValue];
    if (eventTap && !CGEventTapIsEnabled(eventTap)) stopTap();
    if (!wantsTap || !AXIsProcessTrusted()) stopTap();
    else if (!eventTap) {
        eventTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault,
            CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged),
            tapCallback, NULL);
        if (eventTap) {
            tapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0);
            CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, kCFRunLoopCommonModes);
            CGEventTapEnable(eventTap, true);
        }
    }
    return eventTap && CGEventTapIsEnabled(eventTap);
}
bool sshdesk_keyboard_trusted(void) { return AXIsProcessTrusted(); }
void sshdesk_keyboard_request_access(void) {
    AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES});
    [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]];
}

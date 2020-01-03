(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
/**
 * Copyright (c) 2014-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

var runtime = (function (exports) {
  "use strict";

  var Op = Object.prototype;
  var hasOwn = Op.hasOwnProperty;
  var undefined; // More compressible than void 0.
  var $Symbol = typeof Symbol === "function" ? Symbol : {};
  var iteratorSymbol = $Symbol.iterator || "@@iterator";
  var asyncIteratorSymbol = $Symbol.asyncIterator || "@@asyncIterator";
  var toStringTagSymbol = $Symbol.toStringTag || "@@toStringTag";

  function wrap(innerFn, outerFn, self, tryLocsList) {
    // If outerFn provided and outerFn.prototype is a Generator, then outerFn.prototype instanceof Generator.
    var protoGenerator = outerFn && outerFn.prototype instanceof Generator ? outerFn : Generator;
    var generator = Object.create(protoGenerator.prototype);
    var context = new Context(tryLocsList || []);

    // The ._invoke method unifies the implementations of the .next,
    // .throw, and .return methods.
    generator._invoke = makeInvokeMethod(innerFn, self, context);

    return generator;
  }
  exports.wrap = wrap;

  // Try/catch helper to minimize deoptimizations. Returns a completion
  // record like context.tryEntries[i].completion. This interface could
  // have been (and was previously) designed to take a closure to be
  // invoked without arguments, but in all the cases we care about we
  // already have an existing method we want to call, so there's no need
  // to create a new function object. We can even get away with assuming
  // the method takes exactly one argument, since that happens to be true
  // in every case, so we don't have to touch the arguments object. The
  // only additional allocation required is the completion record, which
  // has a stable shape and so hopefully should be cheap to allocate.
  function tryCatch(fn, obj, arg) {
    try {
      return { type: "normal", arg: fn.call(obj, arg) };
    } catch (err) {
      return { type: "throw", arg: err };
    }
  }

  var GenStateSuspendedStart = "suspendedStart";
  var GenStateSuspendedYield = "suspendedYield";
  var GenStateExecuting = "executing";
  var GenStateCompleted = "completed";

  // Returning this object from the innerFn has the same effect as
  // breaking out of the dispatch switch statement.
  var ContinueSentinel = {};

  // Dummy constructor functions that we use as the .constructor and
  // .constructor.prototype properties for functions that return Generator
  // objects. For full spec compliance, you may wish to configure your
  // minifier not to mangle the names of these two functions.
  function Generator() {}
  function GeneratorFunction() {}
  function GeneratorFunctionPrototype() {}

  // This is a polyfill for %IteratorPrototype% for environments that
  // don't natively support it.
  var IteratorPrototype = {};
  IteratorPrototype[iteratorSymbol] = function () {
    return this;
  };

  var getProto = Object.getPrototypeOf;
  var NativeIteratorPrototype = getProto && getProto(getProto(values([])));
  if (NativeIteratorPrototype &&
      NativeIteratorPrototype !== Op &&
      hasOwn.call(NativeIteratorPrototype, iteratorSymbol)) {
    // This environment has a native %IteratorPrototype%; use it instead
    // of the polyfill.
    IteratorPrototype = NativeIteratorPrototype;
  }

  var Gp = GeneratorFunctionPrototype.prototype =
    Generator.prototype = Object.create(IteratorPrototype);
  GeneratorFunction.prototype = Gp.constructor = GeneratorFunctionPrototype;
  GeneratorFunctionPrototype.constructor = GeneratorFunction;
  GeneratorFunctionPrototype[toStringTagSymbol] =
    GeneratorFunction.displayName = "GeneratorFunction";

  // Helper for defining the .next, .throw, and .return methods of the
  // Iterator interface in terms of a single ._invoke method.
  function defineIteratorMethods(prototype) {
    ["next", "throw", "return"].forEach(function(method) {
      prototype[method] = function(arg) {
        return this._invoke(method, arg);
      };
    });
  }

  exports.isGeneratorFunction = function(genFun) {
    var ctor = typeof genFun === "function" && genFun.constructor;
    return ctor
      ? ctor === GeneratorFunction ||
        // For the native GeneratorFunction constructor, the best we can
        // do is to check its .name property.
        (ctor.displayName || ctor.name) === "GeneratorFunction"
      : false;
  };

  exports.mark = function(genFun) {
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(genFun, GeneratorFunctionPrototype);
    } else {
      genFun.__proto__ = GeneratorFunctionPrototype;
      if (!(toStringTagSymbol in genFun)) {
        genFun[toStringTagSymbol] = "GeneratorFunction";
      }
    }
    genFun.prototype = Object.create(Gp);
    return genFun;
  };

  // Within the body of any async function, `await x` is transformed to
  // `yield regeneratorRuntime.awrap(x)`, so that the runtime can test
  // `hasOwn.call(value, "__await")` to determine if the yielded value is
  // meant to be awaited.
  exports.awrap = function(arg) {
    return { __await: arg };
  };

  function AsyncIterator(generator) {
    function invoke(method, arg, resolve, reject) {
      var record = tryCatch(generator[method], generator, arg);
      if (record.type === "throw") {
        reject(record.arg);
      } else {
        var result = record.arg;
        var value = result.value;
        if (value &&
            typeof value === "object" &&
            hasOwn.call(value, "__await")) {
          return Promise.resolve(value.__await).then(function(value) {
            invoke("next", value, resolve, reject);
          }, function(err) {
            invoke("throw", err, resolve, reject);
          });
        }

        return Promise.resolve(value).then(function(unwrapped) {
          // When a yielded Promise is resolved, its final value becomes
          // the .value of the Promise<{value,done}> result for the
          // current iteration.
          result.value = unwrapped;
          resolve(result);
        }, function(error) {
          // If a rejected Promise was yielded, throw the rejection back
          // into the async generator function so it can be handled there.
          return invoke("throw", error, resolve, reject);
        });
      }
    }

    var previousPromise;

    function enqueue(method, arg) {
      function callInvokeWithMethodAndArg() {
        return new Promise(function(resolve, reject) {
          invoke(method, arg, resolve, reject);
        });
      }

      return previousPromise =
        // If enqueue has been called before, then we want to wait until
        // all previous Promises have been resolved before calling invoke,
        // so that results are always delivered in the correct order. If
        // enqueue has not been called before, then it is important to
        // call invoke immediately, without waiting on a callback to fire,
        // so that the async generator function has the opportunity to do
        // any necessary setup in a predictable way. This predictability
        // is why the Promise constructor synchronously invokes its
        // executor callback, and why async functions synchronously
        // execute code before the first await. Since we implement simple
        // async functions in terms of async generators, it is especially
        // important to get this right, even though it requires care.
        previousPromise ? previousPromise.then(
          callInvokeWithMethodAndArg,
          // Avoid propagating failures to Promises returned by later
          // invocations of the iterator.
          callInvokeWithMethodAndArg
        ) : callInvokeWithMethodAndArg();
    }

    // Define the unified helper method that is used to implement .next,
    // .throw, and .return (see defineIteratorMethods).
    this._invoke = enqueue;
  }

  defineIteratorMethods(AsyncIterator.prototype);
  AsyncIterator.prototype[asyncIteratorSymbol] = function () {
    return this;
  };
  exports.AsyncIterator = AsyncIterator;

  // Note that simple async functions are implemented on top of
  // AsyncIterator objects; they just return a Promise for the value of
  // the final result produced by the iterator.
  exports.async = function(innerFn, outerFn, self, tryLocsList) {
    var iter = new AsyncIterator(
      wrap(innerFn, outerFn, self, tryLocsList)
    );

    return exports.isGeneratorFunction(outerFn)
      ? iter // If outerFn is a generator, return the full iterator.
      : iter.next().then(function(result) {
          return result.done ? result.value : iter.next();
        });
  };

  function makeInvokeMethod(innerFn, self, context) {
    var state = GenStateSuspendedStart;

    return function invoke(method, arg) {
      if (state === GenStateExecuting) {
        throw new Error("Generator is already running");
      }

      if (state === GenStateCompleted) {
        if (method === "throw") {
          throw arg;
        }

        // Be forgiving, per 25.3.3.3.3 of the spec:
        // https://people.mozilla.org/~jorendorff/es6-draft.html#sec-generatorresume
        return doneResult();
      }

      context.method = method;
      context.arg = arg;

      while (true) {
        var delegate = context.delegate;
        if (delegate) {
          var delegateResult = maybeInvokeDelegate(delegate, context);
          if (delegateResult) {
            if (delegateResult === ContinueSentinel) continue;
            return delegateResult;
          }
        }

        if (context.method === "next") {
          // Setting context._sent for legacy support of Babel's
          // function.sent implementation.
          context.sent = context._sent = context.arg;

        } else if (context.method === "throw") {
          if (state === GenStateSuspendedStart) {
            state = GenStateCompleted;
            throw context.arg;
          }

          context.dispatchException(context.arg);

        } else if (context.method === "return") {
          context.abrupt("return", context.arg);
        }

        state = GenStateExecuting;

        var record = tryCatch(innerFn, self, context);
        if (record.type === "normal") {
          // If an exception is thrown from innerFn, we leave state ===
          // GenStateExecuting and loop back for another invocation.
          state = context.done
            ? GenStateCompleted
            : GenStateSuspendedYield;

          if (record.arg === ContinueSentinel) {
            continue;
          }

          return {
            value: record.arg,
            done: context.done
          };

        } else if (record.type === "throw") {
          state = GenStateCompleted;
          // Dispatch the exception by looping back around to the
          // context.dispatchException(context.arg) call above.
          context.method = "throw";
          context.arg = record.arg;
        }
      }
    };
  }

  // Call delegate.iterator[context.method](context.arg) and handle the
  // result, either by returning a { value, done } result from the
  // delegate iterator, or by modifying context.method and context.arg,
  // setting context.delegate to null, and returning the ContinueSentinel.
  function maybeInvokeDelegate(delegate, context) {
    var method = delegate.iterator[context.method];
    if (method === undefined) {
      // A .throw or .return when the delegate iterator has no .throw
      // method always terminates the yield* loop.
      context.delegate = null;

      if (context.method === "throw") {
        // Note: ["return"] must be used for ES3 parsing compatibility.
        if (delegate.iterator["return"]) {
          // If the delegate iterator has a return method, give it a
          // chance to clean up.
          context.method = "return";
          context.arg = undefined;
          maybeInvokeDelegate(delegate, context);

          if (context.method === "throw") {
            // If maybeInvokeDelegate(context) changed context.method from
            // "return" to "throw", let that override the TypeError below.
            return ContinueSentinel;
          }
        }

        context.method = "throw";
        context.arg = new TypeError(
          "The iterator does not provide a 'throw' method");
      }

      return ContinueSentinel;
    }

    var record = tryCatch(method, delegate.iterator, context.arg);

    if (record.type === "throw") {
      context.method = "throw";
      context.arg = record.arg;
      context.delegate = null;
      return ContinueSentinel;
    }

    var info = record.arg;

    if (! info) {
      context.method = "throw";
      context.arg = new TypeError("iterator result is not an object");
      context.delegate = null;
      return ContinueSentinel;
    }

    if (info.done) {
      // Assign the result of the finished delegate to the temporary
      // variable specified by delegate.resultName (see delegateYield).
      context[delegate.resultName] = info.value;

      // Resume execution at the desired location (see delegateYield).
      context.next = delegate.nextLoc;

      // If context.method was "throw" but the delegate handled the
      // exception, let the outer generator proceed normally. If
      // context.method was "next", forget context.arg since it has been
      // "consumed" by the delegate iterator. If context.method was
      // "return", allow the original .return call to continue in the
      // outer generator.
      if (context.method !== "return") {
        context.method = "next";
        context.arg = undefined;
      }

    } else {
      // Re-yield the result returned by the delegate method.
      return info;
    }

    // The delegate iterator is finished, so forget it and continue with
    // the outer generator.
    context.delegate = null;
    return ContinueSentinel;
  }

  // Define Generator.prototype.{next,throw,return} in terms of the
  // unified ._invoke helper method.
  defineIteratorMethods(Gp);

  Gp[toStringTagSymbol] = "Generator";

  // A Generator should always return itself as the iterator object when the
  // @@iterator function is called on it. Some browsers' implementations of the
  // iterator prototype chain incorrectly implement this, causing the Generator
  // object to not be returned from this call. This ensures that doesn't happen.
  // See https://github.com/facebook/regenerator/issues/274 for more details.
  Gp[iteratorSymbol] = function() {
    return this;
  };

  Gp.toString = function() {
    return "[object Generator]";
  };

  function pushTryEntry(locs) {
    var entry = { tryLoc: locs[0] };

    if (1 in locs) {
      entry.catchLoc = locs[1];
    }

    if (2 in locs) {
      entry.finallyLoc = locs[2];
      entry.afterLoc = locs[3];
    }

    this.tryEntries.push(entry);
  }

  function resetTryEntry(entry) {
    var record = entry.completion || {};
    record.type = "normal";
    delete record.arg;
    entry.completion = record;
  }

  function Context(tryLocsList) {
    // The root entry object (effectively a try statement without a catch
    // or a finally block) gives us a place to store values thrown from
    // locations where there is no enclosing try statement.
    this.tryEntries = [{ tryLoc: "root" }];
    tryLocsList.forEach(pushTryEntry, this);
    this.reset(true);
  }

  exports.keys = function(object) {
    var keys = [];
    for (var key in object) {
      keys.push(key);
    }
    keys.reverse();

    // Rather than returning an object with a next method, we keep
    // things simple and return the next function itself.
    return function next() {
      while (keys.length) {
        var key = keys.pop();
        if (key in object) {
          next.value = key;
          next.done = false;
          return next;
        }
      }

      // To avoid creating an additional object, we just hang the .value
      // and .done properties off the next function object itself. This
      // also ensures that the minifier will not anonymize the function.
      next.done = true;
      return next;
    };
  };

  function values(iterable) {
    if (iterable) {
      var iteratorMethod = iterable[iteratorSymbol];
      if (iteratorMethod) {
        return iteratorMethod.call(iterable);
      }

      if (typeof iterable.next === "function") {
        return iterable;
      }

      if (!isNaN(iterable.length)) {
        var i = -1, next = function next() {
          while (++i < iterable.length) {
            if (hasOwn.call(iterable, i)) {
              next.value = iterable[i];
              next.done = false;
              return next;
            }
          }

          next.value = undefined;
          next.done = true;

          return next;
        };

        return next.next = next;
      }
    }

    // Return an iterator with no values.
    return { next: doneResult };
  }
  exports.values = values;

  function doneResult() {
    return { value: undefined, done: true };
  }

  Context.prototype = {
    constructor: Context,

    reset: function(skipTempReset) {
      this.prev = 0;
      this.next = 0;
      // Resetting context._sent for legacy support of Babel's
      // function.sent implementation.
      this.sent = this._sent = undefined;
      this.done = false;
      this.delegate = null;

      this.method = "next";
      this.arg = undefined;

      this.tryEntries.forEach(resetTryEntry);

      if (!skipTempReset) {
        for (var name in this) {
          // Not sure about the optimal order of these conditions:
          if (name.charAt(0) === "t" &&
              hasOwn.call(this, name) &&
              !isNaN(+name.slice(1))) {
            this[name] = undefined;
          }
        }
      }
    },

    stop: function() {
      this.done = true;

      var rootEntry = this.tryEntries[0];
      var rootRecord = rootEntry.completion;
      if (rootRecord.type === "throw") {
        throw rootRecord.arg;
      }

      return this.rval;
    },

    dispatchException: function(exception) {
      if (this.done) {
        throw exception;
      }

      var context = this;
      function handle(loc, caught) {
        record.type = "throw";
        record.arg = exception;
        context.next = loc;

        if (caught) {
          // If the dispatched exception was caught by a catch block,
          // then let that catch block handle the exception normally.
          context.method = "next";
          context.arg = undefined;
        }

        return !! caught;
      }

      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        var record = entry.completion;

        if (entry.tryLoc === "root") {
          // Exception thrown outside of any try block that could handle
          // it, so set the completion value of the entire function to
          // throw the exception.
          return handle("end");
        }

        if (entry.tryLoc <= this.prev) {
          var hasCatch = hasOwn.call(entry, "catchLoc");
          var hasFinally = hasOwn.call(entry, "finallyLoc");

          if (hasCatch && hasFinally) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            } else if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else if (hasCatch) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            }

          } else if (hasFinally) {
            if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else {
            throw new Error("try statement without catch or finally");
          }
        }
      }
    },

    abrupt: function(type, arg) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc <= this.prev &&
            hasOwn.call(entry, "finallyLoc") &&
            this.prev < entry.finallyLoc) {
          var finallyEntry = entry;
          break;
        }
      }

      if (finallyEntry &&
          (type === "break" ||
           type === "continue") &&
          finallyEntry.tryLoc <= arg &&
          arg <= finallyEntry.finallyLoc) {
        // Ignore the finally entry if control is not jumping to a
        // location outside the try/catch block.
        finallyEntry = null;
      }

      var record = finallyEntry ? finallyEntry.completion : {};
      record.type = type;
      record.arg = arg;

      if (finallyEntry) {
        this.method = "next";
        this.next = finallyEntry.finallyLoc;
        return ContinueSentinel;
      }

      return this.complete(record);
    },

    complete: function(record, afterLoc) {
      if (record.type === "throw") {
        throw record.arg;
      }

      if (record.type === "break" ||
          record.type === "continue") {
        this.next = record.arg;
      } else if (record.type === "return") {
        this.rval = this.arg = record.arg;
        this.method = "return";
        this.next = "end";
      } else if (record.type === "normal" && afterLoc) {
        this.next = afterLoc;
      }

      return ContinueSentinel;
    },

    finish: function(finallyLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.finallyLoc === finallyLoc) {
          this.complete(entry.completion, entry.afterLoc);
          resetTryEntry(entry);
          return ContinueSentinel;
        }
      }
    },

    "catch": function(tryLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc === tryLoc) {
          var record = entry.completion;
          if (record.type === "throw") {
            var thrown = record.arg;
            resetTryEntry(entry);
          }
          return thrown;
        }
      }

      // The context.catch method must only be called with a location
      // argument that corresponds to a known catch block.
      throw new Error("illegal catch attempt");
    },

    delegateYield: function(iterable, resultName, nextLoc) {
      this.delegate = {
        iterator: values(iterable),
        resultName: resultName,
        nextLoc: nextLoc
      };

      if (this.method === "next") {
        // Deliberately forget the last sent value so that we don't
        // accidentally pass it on to the delegate.
        this.arg = undefined;
      }

      return ContinueSentinel;
    }
  };

  // Regardless of whether this script is executing as a CommonJS module
  // or not, return the runtime object so that we can declare the variable
  // regeneratorRuntime in the outer scope, which allows this module to be
  // injected easily by `bin/regenerator --include-runtime script.js`.
  return exports;

}(
  // If this script is executing as a CommonJS module, use module.exports
  // as the regeneratorRuntime namespace. Otherwise create a new empty
  // object. Either way, the resulting object will be used to initialize
  // the regeneratorRuntime variable at the top of this file.
  typeof module === "object" ? module.exports : {}
));

try {
  regeneratorRuntime = runtime;
} catch (accidentalStrictMode) {
  // This module should not be running in strict mode, so the above
  // assignment should always work unless something is misconfigured. Just
  // in case runtime.js accidentally runs in strict mode, we can escape
  // strict mode using a global Function call. This could conceivably fail
  // if a Content Security Policy forbids using Function, but in that case
  // the proper solution is to fix the accidental strict mode problem. If
  // you've misconfigured your bundler to force strict mode and applied a
  // CSP to forbid Function, and you're not willing to fix either of those
  // problems, please detail your unique predicament in a GitHub issue.
  Function("r", "regeneratorRuntime = r")(runtime);
}

},{}],2:[function(require,module,exports){
"use strict";

function _toConsumableArray(arr) { return _arrayWithoutHoles(arr) || _iterableToArray(arr) || _nonIterableSpread(); }

function _nonIterableSpread() { throw new TypeError("Invalid attempt to spread non-iterable instance"); }

function _iterableToArray(iter) { if (Symbol.iterator in Object(iter) || Object.prototype.toString.call(iter) === "[object Arguments]") return Array.from(iter); }

function _arrayWithoutHoles(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = new Array(arr.length); i < arr.length; i++) { arr2[i] = arr[i]; } return arr2; } }

var regeneratorRuntime = require("regenerator-runtime");

var topline = document.querySelector(".menu");
var mobileMenu = document.getElementById("mobileMenu");
var closeBtn = document.getElementById("closeBtn");
var burger = document.getElementById("burger");
var mobileList = document.getElementById("mobileList");
var seeMore = document.getElementById("seeMore");
var accordeon = document.getElementById("accordeon");
var readMore1 = document.getElementById("readMore1");
var listFirst = document.getElementById("listFirst");
var textFirst = document.getElementById("textFirst");
var textSecond = document.getElementById("textSecond");
var counter = 3;
var raiser = 3;
var products = [{
  src: "img/1. Indoor.jpg",
  subtitle: "Indoor energy services",
  text: "We helped Indoor energy services to greaty simplify their case management system..."
}, {
  src: "img/2. Birdie.jpg",
  subtitle: "Birdie Gold Tours",
  text: "We helped Birdy Golf Tours to stay releveant on an inclreasingly competitive market..."
}, {
  src: "img/3. NowWhere.jpg",
  subtitle: "NowWhere",
  text: "We built a recommendations app for people working in creative industries..."
}, {
  src: "img/4. Fyndiqsvajpen.jpg",
  subtitle: "Fyndiqsvajpen",
  text: "We created an app that helped customers find gifts among more than 2900000 items..."
}, {
  src: "img/5. Bythjul.jpg",
  subtitle: "Bythjul",
  text: "We created tire fashion for the increasingly egalitarian car maintinace market..."
}, {
  src: "img/6. Tickin.jpg",
  subtitle: "Tickin",
  text: "We invented a time reporting system for people who hate time tracking..."
}, {
  src: "img/7. Ubermeds.jpg",
  subtitle: "Ubermeds",
  text: "We created an app that helped customers find gifts among more than 2900000 items..."
}, {
  src: "img/8. Västtrafik Calculator.jpg",
  subtitle: "Västtrafik Calculator",
  text: "We created tire fashion for the increasingly egalitarian car maintinace market..."
}, {
  src: "img/9. Träningspartner.jpg",
  subtitle: "Träningspartner",
  text: "We invented a time reporting system for people who hate time tracking..."
}];
document.addEventListener("scroll", function () {
  if (window.pageYOffset < topline.clientHeight) {
    topline.classList.remove("fixed");
  } else {
    topline.classList.add("fixed");
  }
});

burger.onclick = function (e) {
  e.preventDefault();
  mobileMenu.classList.toggle("hide");
};

closeBtn.onclick = function (e) {
  e.preventDefault();
  mobileMenu.classList.toggle("hide");
};

mobileList.onclick = function () {
  mobileMenu.classList.toggle("hide");
};

accordeon.addEventListener('click', function (e) {
  var target = e.target;
  var list = document.getElementsByClassName('how-we-do__tablet-item');

  var arr = _toConsumableArray(list);

  arr.map(function (i) {
    return i.classList.remove('show');
  });
  target.classList.add('show');
});

readMore1.onclick = function (e) {
  e.preventDefault();
  listFirst.classList.add("more");
  textFirst.classList.add("more");
};

readMore2.onclick = function (e) {
  e.preventDefault();
  textSecond.classList.add("more");
};

var renderProducts = function renderProducts(item) {
  return "<div class=\"col-12 col-md-6 col-lg-4\">\n  <div class=\"projects__card\">\n    <img src=\"".concat(item.src, "\" alt=\"mask\">\n    <div class=\"projects__info\">\n      <h4 class=\"projects__subtitle\">").concat(item.subtitle, "</h4>\n      <p class=\"projects__text\">").concat(item.text, "</p>\n    </div>\n  </div>\n</div>");
};

var renderSection = function renderSection(projectsData) {
  var projects = projectsData.map(function (element) {
    return renderProducts(element);
  });
  document.getElementById("projectsRender").innerHTML = projects.join("");
};

seeMore.onclick = function (e) {
  e.preventDefault();
  counter += raiser;
  renderSection(products.slice(0, counter));
};

window.addEventListener("DOMContentLoaded", function () {
  var witdhCounter = function witdhCounter() {
    return regeneratorRuntime.async(function witdhCounter$(_context) {
      while (1) {
        switch (_context.prev = _context.next) {
          case 0:
            _context.t0 = true;
            _context.next = _context.t0 === document.documentElement.clientWidth > 768 ? 3 : _context.t0 === document.documentElement.clientWidth > 414 ? 5 : 8;
            break;

          case 3:
            counter = 9;
            return _context.abrupt("break", 11);

          case 5:
            counter = 4;
            raiser = 4;
            return _context.abrupt("break", 11);

          case 8:
            counter = 3;
            raiser = 3;
            return _context.abrupt("break", 11);

          case 11:
          case "end":
            return _context.stop();
        }
      }
    });
  };

  witdhCounter();
  renderSection(products.slice(0, counter));
});

},{"regenerator-runtime":1}]},{},[2])

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJub2RlX21vZHVsZXMvcmVnZW5lcmF0b3ItcnVudGltZS9ydW50aW1lLmpzIiwicHJvamVjdHMvd2hpdGVwb3J0LXNpdGUvc3JjL2pzL2FwcC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7Ozs7Ozs7QUN0dEJBLElBQU0sa0JBQWtCLEdBQUcsT0FBTyxDQUFDLHFCQUFELENBQWxDOztBQUVBLElBQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxhQUFULENBQXVCLE9BQXZCLENBQWhCO0FBQ0EsSUFBTSxVQUFVLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsWUFBeEIsQ0FBbkI7QUFDQSxJQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixVQUF4QixDQUFqQjtBQUNBLElBQU0sTUFBTSxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFFBQXhCLENBQWY7QUFDQSxJQUFNLFVBQVUsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixZQUF4QixDQUFuQjtBQUNBLElBQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFNBQXhCLENBQWhCO0FBQ0EsSUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsV0FBeEIsQ0FBbEI7QUFDQSxJQUFNLFNBQVMsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixXQUF4QixDQUFsQjtBQUNBLElBQU0sU0FBUyxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFdBQXhCLENBQWxCO0FBQ0EsSUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsV0FBeEIsQ0FBbEI7QUFDQSxJQUFNLFVBQVUsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixZQUF4QixDQUFuQjtBQUNBLElBQUksT0FBTyxHQUFHLENBQWQ7QUFDQSxJQUFJLE1BQU0sR0FBRyxDQUFiO0FBQ0EsSUFBTSxRQUFRLEdBQUcsQ0FDZjtBQUNFLEVBQUEsR0FBRyxFQUFFLG1CQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsd0JBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBRGUsRUFPZjtBQUNFLEVBQUEsR0FBRyxFQUFFLG1CQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsbUJBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBUGUsRUFhZjtBQUNFLEVBQUEsR0FBRyxFQUFFLHFCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsVUFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0FiZSxFQW1CZjtBQUNFLEVBQUEsR0FBRyxFQUFFLDBCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsZUFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0FuQmUsRUF5QmY7QUFDRSxFQUFBLEdBQUcsRUFBRSxvQkFEUDtBQUVFLEVBQUEsUUFBUSxFQUFFLFNBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBekJlLEVBK0JmO0FBQ0UsRUFBQSxHQUFHLEVBQUUsbUJBRFA7QUFFRSxFQUFBLFFBQVEsRUFBRSxRQUZaO0FBR0UsRUFBQSxJQUFJLEVBQ0Y7QUFKSixDQS9CZSxFQXFDZjtBQUNFLEVBQUEsR0FBRyxFQUFFLHFCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsVUFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0FyQ2UsRUEyQ2Y7QUFDRSxFQUFBLEdBQUcsRUFBRSxrQ0FEUDtBQUVFLEVBQUEsUUFBUSxFQUFFLHVCQUZaO0FBR0UsRUFBQSxJQUFJLEVBQ0Y7QUFKSixDQTNDZSxFQWlEZjtBQUNFLEVBQUEsR0FBRyxFQUFFLDRCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsaUJBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBakRlLENBQWpCO0FBeURBLFFBQVEsQ0FBQyxnQkFBVCxDQUEwQixRQUExQixFQUFvQyxZQUFNO0FBQ3hDLE1BQUksTUFBTSxDQUFDLFdBQVAsR0FBcUIsT0FBTyxDQUFDLFlBQWpDLEVBQStDO0FBQzdDLElBQUEsT0FBTyxDQUFDLFNBQVIsQ0FBa0IsTUFBbEIsQ0FBeUIsT0FBekI7QUFDRCxHQUZELE1BRU87QUFDTCxJQUFBLE9BQU8sQ0FBQyxTQUFSLENBQWtCLEdBQWxCLENBQXNCLE9BQXRCO0FBQ0Q7QUFDRixDQU5EOztBQVFBLE1BQU0sQ0FBQyxPQUFQLEdBQWlCLFVBQUEsQ0FBQyxFQUFJO0FBQ3BCLEVBQUEsQ0FBQyxDQUFDLGNBQUY7QUFDQSxFQUFBLFVBQVUsQ0FBQyxTQUFYLENBQXFCLE1BQXJCLENBQTRCLE1BQTVCO0FBQ0QsQ0FIRDs7QUFLQSxRQUFRLENBQUMsT0FBVCxHQUFtQixVQUFBLENBQUMsRUFBSTtBQUN0QixFQUFBLENBQUMsQ0FBQyxjQUFGO0FBQ0EsRUFBQSxVQUFVLENBQUMsU0FBWCxDQUFxQixNQUFyQixDQUE0QixNQUE1QjtBQUNELENBSEQ7O0FBS0EsVUFBVSxDQUFDLE9BQVgsR0FBcUIsWUFBTTtBQUN6QixFQUFBLFVBQVUsQ0FBQyxTQUFYLENBQXFCLE1BQXJCLENBQTRCLE1BQTVCO0FBQ0QsQ0FGRDs7QUFJQSxTQUFTLENBQUMsZ0JBQVYsQ0FBMkIsT0FBM0IsRUFBb0MsVUFBQyxDQUFELEVBQU87QUFDekMsTUFBSSxNQUFNLEdBQUcsQ0FBQyxDQUFDLE1BQWY7QUFDQSxNQUFNLElBQUksR0FBRyxRQUFRLENBQUMsc0JBQVQsQ0FBZ0Msd0JBQWhDLENBQWI7O0FBQ0EsTUFBSSxHQUFHLHNCQUFPLElBQVAsQ0FBUDs7QUFDQSxFQUFBLEdBQUcsQ0FBQyxHQUFKLENBQVEsVUFBQSxDQUFDO0FBQUEsV0FBSSxDQUFDLENBQUMsU0FBRixDQUFZLE1BQVosQ0FBbUIsTUFBbkIsQ0FBSjtBQUFBLEdBQVQ7QUFDQSxFQUFBLE1BQU0sQ0FBQyxTQUFQLENBQWlCLEdBQWpCLENBQXFCLE1BQXJCO0FBQ0QsQ0FORDs7QUFRQSxTQUFTLENBQUMsT0FBVixHQUFvQixVQUFBLENBQUMsRUFBSTtBQUN2QixFQUFBLENBQUMsQ0FBQyxjQUFGO0FBQ0EsRUFBQSxTQUFTLENBQUMsU0FBVixDQUFvQixHQUFwQixDQUF3QixNQUF4QjtBQUNBLEVBQUEsU0FBUyxDQUFDLFNBQVYsQ0FBb0IsR0FBcEIsQ0FBd0IsTUFBeEI7QUFDRCxDQUpEOztBQU1BLFNBQVMsQ0FBQyxPQUFWLEdBQW9CLFVBQUEsQ0FBQyxFQUFJO0FBQ3ZCLEVBQUEsQ0FBQyxDQUFDLGNBQUY7QUFDQSxFQUFBLFVBQVUsQ0FBQyxTQUFYLENBQXFCLEdBQXJCLENBQXlCLE1BQXpCO0FBQ0QsQ0FIRDs7QUFLQSxJQUFNLGNBQWMsR0FBRyxTQUFqQixjQUFpQixDQUFBLElBQUksRUFBSTtBQUM3Qiw4R0FFYyxJQUFJLENBQUMsR0FGbkIsMEdBSXFDLElBQUksQ0FBQyxRQUoxQyxzREFLZ0MsSUFBSSxDQUFDLElBTHJDO0FBU0QsQ0FWRDs7QUFZQSxJQUFJLGFBQWEsR0FBRyxTQUFoQixhQUFnQixDQUFBLFlBQVksRUFBSTtBQUNsQyxNQUFNLFFBQVEsR0FBRyxZQUFZLENBQUMsR0FBYixDQUFpQixVQUFBLE9BQU87QUFBQSxXQUFJLGNBQWMsQ0FBQyxPQUFELENBQWxCO0FBQUEsR0FBeEIsQ0FBakI7QUFDQSxFQUFBLFFBQVEsQ0FBQyxjQUFULENBQXdCLGdCQUF4QixFQUEwQyxTQUExQyxHQUFzRCxRQUFRLENBQUMsSUFBVCxDQUFjLEVBQWQsQ0FBdEQ7QUFDRCxDQUhEOztBQUtBLE9BQU8sQ0FBQyxPQUFSLEdBQWtCLFVBQUEsQ0FBQyxFQUFJO0FBQ3JCLEVBQUEsQ0FBQyxDQUFDLGNBQUY7QUFDQSxFQUFBLE9BQU8sSUFBSSxNQUFYO0FBQ0EsRUFBQSxhQUFhLENBQUMsUUFBUSxDQUFDLEtBQVQsQ0FBZSxDQUFmLEVBQWtCLE9BQWxCLENBQUQsQ0FBYjtBQUNELENBSkQ7O0FBTUEsTUFBTSxDQUFDLGdCQUFQLENBQXdCLGtCQUF4QixFQUE0QyxZQUFNO0FBQ2hELE1BQU0sWUFBWSxHQUFHLFNBQWYsWUFBZTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsMEJBQ1gsSUFEVztBQUFBLDRDQUVaLFFBQVEsQ0FBQyxlQUFULENBQXlCLFdBQXpCLEdBQXVDLEdBRjNCLHVCQUtaLFFBQVEsQ0FBQyxlQUFULENBQXlCLFdBQXpCLEdBQXVDLEdBTDNCO0FBQUE7O0FBQUE7QUFHZixZQUFBLE9BQU8sR0FBRyxDQUFWO0FBSGU7O0FBQUE7QUFNZixZQUFBLE9BQU8sR0FBRyxDQUFWO0FBQ0EsWUFBQSxNQUFNLEdBQUcsQ0FBVDtBQVBlOztBQUFBO0FBVWYsWUFBQSxPQUFPLEdBQUcsQ0FBVjtBQUNBLFlBQUEsTUFBTSxHQUFHLENBQVQ7QUFYZTs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxHQUFyQjs7QUFlQSxFQUFBLFlBQVk7QUFDWixFQUFBLGFBQWEsQ0FBQyxRQUFRLENBQUMsS0FBVCxDQUFlLENBQWYsRUFBa0IsT0FBbEIsQ0FBRCxDQUFiO0FBQ0QsQ0FsQkQiLCJmaWxlIjoiYnVuZGxlLmpzIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uKCl7ZnVuY3Rpb24gcihlLG4sdCl7ZnVuY3Rpb24gbyhpLGYpe2lmKCFuW2ldKXtpZighZVtpXSl7dmFyIGM9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWlyZSYmcmVxdWlyZTtpZighZiYmYylyZXR1cm4gYyhpLCEwKTtpZih1KXJldHVybiB1KGksITApO3ZhciBhPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIraStcIidcIik7dGhyb3cgYS5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGF9dmFyIHA9bltpXT17ZXhwb3J0czp7fX07ZVtpXVswXS5jYWxsKHAuZXhwb3J0cyxmdW5jdGlvbihyKXt2YXIgbj1lW2ldWzFdW3JdO3JldHVybiBvKG58fHIpfSxwLHAuZXhwb3J0cyxyLGUsbix0KX1yZXR1cm4gbltpXS5leHBvcnRzfWZvcih2YXIgdT1cImZ1bmN0aW9uXCI9PXR5cGVvZiByZXF1aXJlJiZyZXF1aXJlLGk9MDtpPHQubGVuZ3RoO2krKylvKHRbaV0pO3JldHVybiBvfXJldHVybiByfSkoKSIsIi8qKlxuICogQ29weXJpZ2h0IChjKSAyMDE0LXByZXNlbnQsIEZhY2Vib29rLCBJbmMuXG4gKlxuICogVGhpcyBzb3VyY2UgY29kZSBpcyBsaWNlbnNlZCB1bmRlciB0aGUgTUlUIGxpY2Vuc2UgZm91bmQgaW4gdGhlXG4gKiBMSUNFTlNFIGZpbGUgaW4gdGhlIHJvb3QgZGlyZWN0b3J5IG9mIHRoaXMgc291cmNlIHRyZWUuXG4gKi9cblxudmFyIHJ1bnRpbWUgPSAoZnVuY3Rpb24gKGV4cG9ydHMpIHtcbiAgXCJ1c2Ugc3RyaWN0XCI7XG5cbiAgdmFyIE9wID0gT2JqZWN0LnByb3RvdHlwZTtcbiAgdmFyIGhhc093biA9IE9wLmhhc093blByb3BlcnR5O1xuICB2YXIgdW5kZWZpbmVkOyAvLyBNb3JlIGNvbXByZXNzaWJsZSB0aGFuIHZvaWQgMC5cbiAgdmFyICRTeW1ib2wgPSB0eXBlb2YgU3ltYm9sID09PSBcImZ1bmN0aW9uXCIgPyBTeW1ib2wgOiB7fTtcbiAgdmFyIGl0ZXJhdG9yU3ltYm9sID0gJFN5bWJvbC5pdGVyYXRvciB8fCBcIkBAaXRlcmF0b3JcIjtcbiAgdmFyIGFzeW5jSXRlcmF0b3JTeW1ib2wgPSAkU3ltYm9sLmFzeW5jSXRlcmF0b3IgfHwgXCJAQGFzeW5jSXRlcmF0b3JcIjtcbiAgdmFyIHRvU3RyaW5nVGFnU3ltYm9sID0gJFN5bWJvbC50b1N0cmluZ1RhZyB8fCBcIkBAdG9TdHJpbmdUYWdcIjtcblxuICBmdW5jdGlvbiB3cmFwKGlubmVyRm4sIG91dGVyRm4sIHNlbGYsIHRyeUxvY3NMaXN0KSB7XG4gICAgLy8gSWYgb3V0ZXJGbiBwcm92aWRlZCBhbmQgb3V0ZXJGbi5wcm90b3R5cGUgaXMgYSBHZW5lcmF0b3IsIHRoZW4gb3V0ZXJGbi5wcm90b3R5cGUgaW5zdGFuY2VvZiBHZW5lcmF0b3IuXG4gICAgdmFyIHByb3RvR2VuZXJhdG9yID0gb3V0ZXJGbiAmJiBvdXRlckZuLnByb3RvdHlwZSBpbnN0YW5jZW9mIEdlbmVyYXRvciA/IG91dGVyRm4gOiBHZW5lcmF0b3I7XG4gICAgdmFyIGdlbmVyYXRvciA9IE9iamVjdC5jcmVhdGUocHJvdG9HZW5lcmF0b3IucHJvdG90eXBlKTtcbiAgICB2YXIgY29udGV4dCA9IG5ldyBDb250ZXh0KHRyeUxvY3NMaXN0IHx8IFtdKTtcblxuICAgIC8vIFRoZSAuX2ludm9rZSBtZXRob2QgdW5pZmllcyB0aGUgaW1wbGVtZW50YXRpb25zIG9mIHRoZSAubmV4dCxcbiAgICAvLyAudGhyb3csIGFuZCAucmV0dXJuIG1ldGhvZHMuXG4gICAgZ2VuZXJhdG9yLl9pbnZva2UgPSBtYWtlSW52b2tlTWV0aG9kKGlubmVyRm4sIHNlbGYsIGNvbnRleHQpO1xuXG4gICAgcmV0dXJuIGdlbmVyYXRvcjtcbiAgfVxuICBleHBvcnRzLndyYXAgPSB3cmFwO1xuXG4gIC8vIFRyeS9jYXRjaCBoZWxwZXIgdG8gbWluaW1pemUgZGVvcHRpbWl6YXRpb25zLiBSZXR1cm5zIGEgY29tcGxldGlvblxuICAvLyByZWNvcmQgbGlrZSBjb250ZXh0LnRyeUVudHJpZXNbaV0uY29tcGxldGlvbi4gVGhpcyBpbnRlcmZhY2UgY291bGRcbiAgLy8gaGF2ZSBiZWVuIChhbmQgd2FzIHByZXZpb3VzbHkpIGRlc2lnbmVkIHRvIHRha2UgYSBjbG9zdXJlIHRvIGJlXG4gIC8vIGludm9rZWQgd2l0aG91dCBhcmd1bWVudHMsIGJ1dCBpbiBhbGwgdGhlIGNhc2VzIHdlIGNhcmUgYWJvdXQgd2VcbiAgLy8gYWxyZWFkeSBoYXZlIGFuIGV4aXN0aW5nIG1ldGhvZCB3ZSB3YW50IHRvIGNhbGwsIHNvIHRoZXJlJ3Mgbm8gbmVlZFxuICAvLyB0byBjcmVhdGUgYSBuZXcgZnVuY3Rpb24gb2JqZWN0LiBXZSBjYW4gZXZlbiBnZXQgYXdheSB3aXRoIGFzc3VtaW5nXG4gIC8vIHRoZSBtZXRob2QgdGFrZXMgZXhhY3RseSBvbmUgYXJndW1lbnQsIHNpbmNlIHRoYXQgaGFwcGVucyB0byBiZSB0cnVlXG4gIC8vIGluIGV2ZXJ5IGNhc2UsIHNvIHdlIGRvbid0IGhhdmUgdG8gdG91Y2ggdGhlIGFyZ3VtZW50cyBvYmplY3QuIFRoZVxuICAvLyBvbmx5IGFkZGl0aW9uYWwgYWxsb2NhdGlvbiByZXF1aXJlZCBpcyB0aGUgY29tcGxldGlvbiByZWNvcmQsIHdoaWNoXG4gIC8vIGhhcyBhIHN0YWJsZSBzaGFwZSBhbmQgc28gaG9wZWZ1bGx5IHNob3VsZCBiZSBjaGVhcCB0byBhbGxvY2F0ZS5cbiAgZnVuY3Rpb24gdHJ5Q2F0Y2goZm4sIG9iaiwgYXJnKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiB7IHR5cGU6IFwibm9ybWFsXCIsIGFyZzogZm4uY2FsbChvYmosIGFyZykgfTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiB7IHR5cGU6IFwidGhyb3dcIiwgYXJnOiBlcnIgfTtcbiAgICB9XG4gIH1cblxuICB2YXIgR2VuU3RhdGVTdXNwZW5kZWRTdGFydCA9IFwic3VzcGVuZGVkU3RhcnRcIjtcbiAgdmFyIEdlblN0YXRlU3VzcGVuZGVkWWllbGQgPSBcInN1c3BlbmRlZFlpZWxkXCI7XG4gIHZhciBHZW5TdGF0ZUV4ZWN1dGluZyA9IFwiZXhlY3V0aW5nXCI7XG4gIHZhciBHZW5TdGF0ZUNvbXBsZXRlZCA9IFwiY29tcGxldGVkXCI7XG5cbiAgLy8gUmV0dXJuaW5nIHRoaXMgb2JqZWN0IGZyb20gdGhlIGlubmVyRm4gaGFzIHRoZSBzYW1lIGVmZmVjdCBhc1xuICAvLyBicmVha2luZyBvdXQgb2YgdGhlIGRpc3BhdGNoIHN3aXRjaCBzdGF0ZW1lbnQuXG4gIHZhciBDb250aW51ZVNlbnRpbmVsID0ge307XG5cbiAgLy8gRHVtbXkgY29uc3RydWN0b3IgZnVuY3Rpb25zIHRoYXQgd2UgdXNlIGFzIHRoZSAuY29uc3RydWN0b3IgYW5kXG4gIC8vIC5jb25zdHJ1Y3Rvci5wcm90b3R5cGUgcHJvcGVydGllcyBmb3IgZnVuY3Rpb25zIHRoYXQgcmV0dXJuIEdlbmVyYXRvclxuICAvLyBvYmplY3RzLiBGb3IgZnVsbCBzcGVjIGNvbXBsaWFuY2UsIHlvdSBtYXkgd2lzaCB0byBjb25maWd1cmUgeW91clxuICAvLyBtaW5pZmllciBub3QgdG8gbWFuZ2xlIHRoZSBuYW1lcyBvZiB0aGVzZSB0d28gZnVuY3Rpb25zLlxuICBmdW5jdGlvbiBHZW5lcmF0b3IoKSB7fVxuICBmdW5jdGlvbiBHZW5lcmF0b3JGdW5jdGlvbigpIHt9XG4gIGZ1bmN0aW9uIEdlbmVyYXRvckZ1bmN0aW9uUHJvdG90eXBlKCkge31cblxuICAvLyBUaGlzIGlzIGEgcG9seWZpbGwgZm9yICVJdGVyYXRvclByb3RvdHlwZSUgZm9yIGVudmlyb25tZW50cyB0aGF0XG4gIC8vIGRvbid0IG5hdGl2ZWx5IHN1cHBvcnQgaXQuXG4gIHZhciBJdGVyYXRvclByb3RvdHlwZSA9IHt9O1xuICBJdGVyYXRvclByb3RvdHlwZVtpdGVyYXRvclN5bWJvbF0gPSBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH07XG5cbiAgdmFyIGdldFByb3RvID0gT2JqZWN0LmdldFByb3RvdHlwZU9mO1xuICB2YXIgTmF0aXZlSXRlcmF0b3JQcm90b3R5cGUgPSBnZXRQcm90byAmJiBnZXRQcm90byhnZXRQcm90byh2YWx1ZXMoW10pKSk7XG4gIGlmIChOYXRpdmVJdGVyYXRvclByb3RvdHlwZSAmJlxuICAgICAgTmF0aXZlSXRlcmF0b3JQcm90b3R5cGUgIT09IE9wICYmXG4gICAgICBoYXNPd24uY2FsbChOYXRpdmVJdGVyYXRvclByb3RvdHlwZSwgaXRlcmF0b3JTeW1ib2wpKSB7XG4gICAgLy8gVGhpcyBlbnZpcm9ubWVudCBoYXMgYSBuYXRpdmUgJUl0ZXJhdG9yUHJvdG90eXBlJTsgdXNlIGl0IGluc3RlYWRcbiAgICAvLyBvZiB0aGUgcG9seWZpbGwuXG4gICAgSXRlcmF0b3JQcm90b3R5cGUgPSBOYXRpdmVJdGVyYXRvclByb3RvdHlwZTtcbiAgfVxuXG4gIHZhciBHcCA9IEdlbmVyYXRvckZ1bmN0aW9uUHJvdG90eXBlLnByb3RvdHlwZSA9XG4gICAgR2VuZXJhdG9yLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoSXRlcmF0b3JQcm90b3R5cGUpO1xuICBHZW5lcmF0b3JGdW5jdGlvbi5wcm90b3R5cGUgPSBHcC5jb25zdHJ1Y3RvciA9IEdlbmVyYXRvckZ1bmN0aW9uUHJvdG90eXBlO1xuICBHZW5lcmF0b3JGdW5jdGlvblByb3RvdHlwZS5jb25zdHJ1Y3RvciA9IEdlbmVyYXRvckZ1bmN0aW9uO1xuICBHZW5lcmF0b3JGdW5jdGlvblByb3RvdHlwZVt0b1N0cmluZ1RhZ1N5bWJvbF0gPVxuICAgIEdlbmVyYXRvckZ1bmN0aW9uLmRpc3BsYXlOYW1lID0gXCJHZW5lcmF0b3JGdW5jdGlvblwiO1xuXG4gIC8vIEhlbHBlciBmb3IgZGVmaW5pbmcgdGhlIC5uZXh0LCAudGhyb3csIGFuZCAucmV0dXJuIG1ldGhvZHMgb2YgdGhlXG4gIC8vIEl0ZXJhdG9yIGludGVyZmFjZSBpbiB0ZXJtcyBvZiBhIHNpbmdsZSAuX2ludm9rZSBtZXRob2QuXG4gIGZ1bmN0aW9uIGRlZmluZUl0ZXJhdG9yTWV0aG9kcyhwcm90b3R5cGUpIHtcbiAgICBbXCJuZXh0XCIsIFwidGhyb3dcIiwgXCJyZXR1cm5cIl0uZm9yRWFjaChmdW5jdGlvbihtZXRob2QpIHtcbiAgICAgIHByb3RvdHlwZVttZXRob2RdID0gZnVuY3Rpb24oYXJnKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9pbnZva2UobWV0aG9kLCBhcmcpO1xuICAgICAgfTtcbiAgICB9KTtcbiAgfVxuXG4gIGV4cG9ydHMuaXNHZW5lcmF0b3JGdW5jdGlvbiA9IGZ1bmN0aW9uKGdlbkZ1bikge1xuICAgIHZhciBjdG9yID0gdHlwZW9mIGdlbkZ1biA9PT0gXCJmdW5jdGlvblwiICYmIGdlbkZ1bi5jb25zdHJ1Y3RvcjtcbiAgICByZXR1cm4gY3RvclxuICAgICAgPyBjdG9yID09PSBHZW5lcmF0b3JGdW5jdGlvbiB8fFxuICAgICAgICAvLyBGb3IgdGhlIG5hdGl2ZSBHZW5lcmF0b3JGdW5jdGlvbiBjb25zdHJ1Y3RvciwgdGhlIGJlc3Qgd2UgY2FuXG4gICAgICAgIC8vIGRvIGlzIHRvIGNoZWNrIGl0cyAubmFtZSBwcm9wZXJ0eS5cbiAgICAgICAgKGN0b3IuZGlzcGxheU5hbWUgfHwgY3Rvci5uYW1lKSA9PT0gXCJHZW5lcmF0b3JGdW5jdGlvblwiXG4gICAgICA6IGZhbHNlO1xuICB9O1xuXG4gIGV4cG9ydHMubWFyayA9IGZ1bmN0aW9uKGdlbkZ1bikge1xuICAgIGlmIChPYmplY3Quc2V0UHJvdG90eXBlT2YpIHtcbiAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihnZW5GdW4sIEdlbmVyYXRvckZ1bmN0aW9uUHJvdG90eXBlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgZ2VuRnVuLl9fcHJvdG9fXyA9IEdlbmVyYXRvckZ1bmN0aW9uUHJvdG90eXBlO1xuICAgICAgaWYgKCEodG9TdHJpbmdUYWdTeW1ib2wgaW4gZ2VuRnVuKSkge1xuICAgICAgICBnZW5GdW5bdG9TdHJpbmdUYWdTeW1ib2xdID0gXCJHZW5lcmF0b3JGdW5jdGlvblwiO1xuICAgICAgfVxuICAgIH1cbiAgICBnZW5GdW4ucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShHcCk7XG4gICAgcmV0dXJuIGdlbkZ1bjtcbiAgfTtcblxuICAvLyBXaXRoaW4gdGhlIGJvZHkgb2YgYW55IGFzeW5jIGZ1bmN0aW9uLCBgYXdhaXQgeGAgaXMgdHJhbnNmb3JtZWQgdG9cbiAgLy8gYHlpZWxkIHJlZ2VuZXJhdG9yUnVudGltZS5hd3JhcCh4KWAsIHNvIHRoYXQgdGhlIHJ1bnRpbWUgY2FuIHRlc3RcbiAgLy8gYGhhc093bi5jYWxsKHZhbHVlLCBcIl9fYXdhaXRcIilgIHRvIGRldGVybWluZSBpZiB0aGUgeWllbGRlZCB2YWx1ZSBpc1xuICAvLyBtZWFudCB0byBiZSBhd2FpdGVkLlxuICBleHBvcnRzLmF3cmFwID0gZnVuY3Rpb24oYXJnKSB7XG4gICAgcmV0dXJuIHsgX19hd2FpdDogYXJnIH07XG4gIH07XG5cbiAgZnVuY3Rpb24gQXN5bmNJdGVyYXRvcihnZW5lcmF0b3IpIHtcbiAgICBmdW5jdGlvbiBpbnZva2UobWV0aG9kLCBhcmcsIHJlc29sdmUsIHJlamVjdCkge1xuICAgICAgdmFyIHJlY29yZCA9IHRyeUNhdGNoKGdlbmVyYXRvclttZXRob2RdLCBnZW5lcmF0b3IsIGFyZyk7XG4gICAgICBpZiAocmVjb3JkLnR5cGUgPT09IFwidGhyb3dcIikge1xuICAgICAgICByZWplY3QocmVjb3JkLmFyZyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgcmVzdWx0ID0gcmVjb3JkLmFyZztcbiAgICAgICAgdmFyIHZhbHVlID0gcmVzdWx0LnZhbHVlO1xuICAgICAgICBpZiAodmFsdWUgJiZcbiAgICAgICAgICAgIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiAmJlxuICAgICAgICAgICAgaGFzT3duLmNhbGwodmFsdWUsIFwiX19hd2FpdFwiKSkge1xuICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodmFsdWUuX19hd2FpdCkudGhlbihmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgICAgICAgaW52b2tlKFwibmV4dFwiLCB2YWx1ZSwgcmVzb2x2ZSwgcmVqZWN0KTtcbiAgICAgICAgICB9LCBmdW5jdGlvbihlcnIpIHtcbiAgICAgICAgICAgIGludm9rZShcInRocm93XCIsIGVyciwgcmVzb2x2ZSwgcmVqZWN0KTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodmFsdWUpLnRoZW4oZnVuY3Rpb24odW53cmFwcGVkKSB7XG4gICAgICAgICAgLy8gV2hlbiBhIHlpZWxkZWQgUHJvbWlzZSBpcyByZXNvbHZlZCwgaXRzIGZpbmFsIHZhbHVlIGJlY29tZXNcbiAgICAgICAgICAvLyB0aGUgLnZhbHVlIG9mIHRoZSBQcm9taXNlPHt2YWx1ZSxkb25lfT4gcmVzdWx0IGZvciB0aGVcbiAgICAgICAgICAvLyBjdXJyZW50IGl0ZXJhdGlvbi5cbiAgICAgICAgICByZXN1bHQudmFsdWUgPSB1bndyYXBwZWQ7XG4gICAgICAgICAgcmVzb2x2ZShyZXN1bHQpO1xuICAgICAgICB9LCBmdW5jdGlvbihlcnJvcikge1xuICAgICAgICAgIC8vIElmIGEgcmVqZWN0ZWQgUHJvbWlzZSB3YXMgeWllbGRlZCwgdGhyb3cgdGhlIHJlamVjdGlvbiBiYWNrXG4gICAgICAgICAgLy8gaW50byB0aGUgYXN5bmMgZ2VuZXJhdG9yIGZ1bmN0aW9uIHNvIGl0IGNhbiBiZSBoYW5kbGVkIHRoZXJlLlxuICAgICAgICAgIHJldHVybiBpbnZva2UoXCJ0aHJvd1wiLCBlcnJvciwgcmVzb2x2ZSwgcmVqZWN0KTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdmFyIHByZXZpb3VzUHJvbWlzZTtcblxuICAgIGZ1bmN0aW9uIGVucXVldWUobWV0aG9kLCBhcmcpIHtcbiAgICAgIGZ1bmN0aW9uIGNhbGxJbnZva2VXaXRoTWV0aG9kQW5kQXJnKCkge1xuICAgICAgICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgICAgICAgaW52b2tlKG1ldGhvZCwgYXJnLCByZXNvbHZlLCByZWplY3QpO1xuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHByZXZpb3VzUHJvbWlzZSA9XG4gICAgICAgIC8vIElmIGVucXVldWUgaGFzIGJlZW4gY2FsbGVkIGJlZm9yZSwgdGhlbiB3ZSB3YW50IHRvIHdhaXQgdW50aWxcbiAgICAgICAgLy8gYWxsIHByZXZpb3VzIFByb21pc2VzIGhhdmUgYmVlbiByZXNvbHZlZCBiZWZvcmUgY2FsbGluZyBpbnZva2UsXG4gICAgICAgIC8vIHNvIHRoYXQgcmVzdWx0cyBhcmUgYWx3YXlzIGRlbGl2ZXJlZCBpbiB0aGUgY29ycmVjdCBvcmRlci4gSWZcbiAgICAgICAgLy8gZW5xdWV1ZSBoYXMgbm90IGJlZW4gY2FsbGVkIGJlZm9yZSwgdGhlbiBpdCBpcyBpbXBvcnRhbnQgdG9cbiAgICAgICAgLy8gY2FsbCBpbnZva2UgaW1tZWRpYXRlbHksIHdpdGhvdXQgd2FpdGluZyBvbiBhIGNhbGxiYWNrIHRvIGZpcmUsXG4gICAgICAgIC8vIHNvIHRoYXQgdGhlIGFzeW5jIGdlbmVyYXRvciBmdW5jdGlvbiBoYXMgdGhlIG9wcG9ydHVuaXR5IHRvIGRvXG4gICAgICAgIC8vIGFueSBuZWNlc3Nhcnkgc2V0dXAgaW4gYSBwcmVkaWN0YWJsZSB3YXkuIFRoaXMgcHJlZGljdGFiaWxpdHlcbiAgICAgICAgLy8gaXMgd2h5IHRoZSBQcm9taXNlIGNvbnN0cnVjdG9yIHN5bmNocm9ub3VzbHkgaW52b2tlcyBpdHNcbiAgICAgICAgLy8gZXhlY3V0b3IgY2FsbGJhY2ssIGFuZCB3aHkgYXN5bmMgZnVuY3Rpb25zIHN5bmNocm9ub3VzbHlcbiAgICAgICAgLy8gZXhlY3V0ZSBjb2RlIGJlZm9yZSB0aGUgZmlyc3QgYXdhaXQuIFNpbmNlIHdlIGltcGxlbWVudCBzaW1wbGVcbiAgICAgICAgLy8gYXN5bmMgZnVuY3Rpb25zIGluIHRlcm1zIG9mIGFzeW5jIGdlbmVyYXRvcnMsIGl0IGlzIGVzcGVjaWFsbHlcbiAgICAgICAgLy8gaW1wb3J0YW50IHRvIGdldCB0aGlzIHJpZ2h0LCBldmVuIHRob3VnaCBpdCByZXF1aXJlcyBjYXJlLlxuICAgICAgICBwcmV2aW91c1Byb21pc2UgPyBwcmV2aW91c1Byb21pc2UudGhlbihcbiAgICAgICAgICBjYWxsSW52b2tlV2l0aE1ldGhvZEFuZEFyZyxcbiAgICAgICAgICAvLyBBdm9pZCBwcm9wYWdhdGluZyBmYWlsdXJlcyB0byBQcm9taXNlcyByZXR1cm5lZCBieSBsYXRlclxuICAgICAgICAgIC8vIGludm9jYXRpb25zIG9mIHRoZSBpdGVyYXRvci5cbiAgICAgICAgICBjYWxsSW52b2tlV2l0aE1ldGhvZEFuZEFyZ1xuICAgICAgICApIDogY2FsbEludm9rZVdpdGhNZXRob2RBbmRBcmcoKTtcbiAgICB9XG5cbiAgICAvLyBEZWZpbmUgdGhlIHVuaWZpZWQgaGVscGVyIG1ldGhvZCB0aGF0IGlzIHVzZWQgdG8gaW1wbGVtZW50IC5uZXh0LFxuICAgIC8vIC50aHJvdywgYW5kIC5yZXR1cm4gKHNlZSBkZWZpbmVJdGVyYXRvck1ldGhvZHMpLlxuICAgIHRoaXMuX2ludm9rZSA9IGVucXVldWU7XG4gIH1cblxuICBkZWZpbmVJdGVyYXRvck1ldGhvZHMoQXN5bmNJdGVyYXRvci5wcm90b3R5cGUpO1xuICBBc3luY0l0ZXJhdG9yLnByb3RvdHlwZVthc3luY0l0ZXJhdG9yU3ltYm9sXSA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcztcbiAgfTtcbiAgZXhwb3J0cy5Bc3luY0l0ZXJhdG9yID0gQXN5bmNJdGVyYXRvcjtcblxuICAvLyBOb3RlIHRoYXQgc2ltcGxlIGFzeW5jIGZ1bmN0aW9ucyBhcmUgaW1wbGVtZW50ZWQgb24gdG9wIG9mXG4gIC8vIEFzeW5jSXRlcmF0b3Igb2JqZWN0czsgdGhleSBqdXN0IHJldHVybiBhIFByb21pc2UgZm9yIHRoZSB2YWx1ZSBvZlxuICAvLyB0aGUgZmluYWwgcmVzdWx0IHByb2R1Y2VkIGJ5IHRoZSBpdGVyYXRvci5cbiAgZXhwb3J0cy5hc3luYyA9IGZ1bmN0aW9uKGlubmVyRm4sIG91dGVyRm4sIHNlbGYsIHRyeUxvY3NMaXN0KSB7XG4gICAgdmFyIGl0ZXIgPSBuZXcgQXN5bmNJdGVyYXRvcihcbiAgICAgIHdyYXAoaW5uZXJGbiwgb3V0ZXJGbiwgc2VsZiwgdHJ5TG9jc0xpc3QpXG4gICAgKTtcblxuICAgIHJldHVybiBleHBvcnRzLmlzR2VuZXJhdG9yRnVuY3Rpb24ob3V0ZXJGbilcbiAgICAgID8gaXRlciAvLyBJZiBvdXRlckZuIGlzIGEgZ2VuZXJhdG9yLCByZXR1cm4gdGhlIGZ1bGwgaXRlcmF0b3IuXG4gICAgICA6IGl0ZXIubmV4dCgpLnRoZW4oZnVuY3Rpb24ocmVzdWx0KSB7XG4gICAgICAgICAgcmV0dXJuIHJlc3VsdC5kb25lID8gcmVzdWx0LnZhbHVlIDogaXRlci5uZXh0KCk7XG4gICAgICAgIH0pO1xuICB9O1xuXG4gIGZ1bmN0aW9uIG1ha2VJbnZva2VNZXRob2QoaW5uZXJGbiwgc2VsZiwgY29udGV4dCkge1xuICAgIHZhciBzdGF0ZSA9IEdlblN0YXRlU3VzcGVuZGVkU3RhcnQ7XG5cbiAgICByZXR1cm4gZnVuY3Rpb24gaW52b2tlKG1ldGhvZCwgYXJnKSB7XG4gICAgICBpZiAoc3RhdGUgPT09IEdlblN0YXRlRXhlY3V0aW5nKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkdlbmVyYXRvciBpcyBhbHJlYWR5IHJ1bm5pbmdcIik7XG4gICAgICB9XG5cbiAgICAgIGlmIChzdGF0ZSA9PT0gR2VuU3RhdGVDb21wbGV0ZWQpIHtcbiAgICAgICAgaWYgKG1ldGhvZCA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICAgICAgdGhyb3cgYXJnO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQmUgZm9yZ2l2aW5nLCBwZXIgMjUuMy4zLjMuMyBvZiB0aGUgc3BlYzpcbiAgICAgICAgLy8gaHR0cHM6Ly9wZW9wbGUubW96aWxsYS5vcmcvfmpvcmVuZG9yZmYvZXM2LWRyYWZ0Lmh0bWwjc2VjLWdlbmVyYXRvcnJlc3VtZVxuICAgICAgICByZXR1cm4gZG9uZVJlc3VsdCgpO1xuICAgICAgfVxuXG4gICAgICBjb250ZXh0Lm1ldGhvZCA9IG1ldGhvZDtcbiAgICAgIGNvbnRleHQuYXJnID0gYXJnO1xuXG4gICAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgICB2YXIgZGVsZWdhdGUgPSBjb250ZXh0LmRlbGVnYXRlO1xuICAgICAgICBpZiAoZGVsZWdhdGUpIHtcbiAgICAgICAgICB2YXIgZGVsZWdhdGVSZXN1bHQgPSBtYXliZUludm9rZURlbGVnYXRlKGRlbGVnYXRlLCBjb250ZXh0KTtcbiAgICAgICAgICBpZiAoZGVsZWdhdGVSZXN1bHQpIHtcbiAgICAgICAgICAgIGlmIChkZWxlZ2F0ZVJlc3VsdCA9PT0gQ29udGludWVTZW50aW5lbCkgY29udGludWU7XG4gICAgICAgICAgICByZXR1cm4gZGVsZWdhdGVSZXN1bHQ7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQubWV0aG9kID09PSBcIm5leHRcIikge1xuICAgICAgICAgIC8vIFNldHRpbmcgY29udGV4dC5fc2VudCBmb3IgbGVnYWN5IHN1cHBvcnQgb2YgQmFiZWwnc1xuICAgICAgICAgIC8vIGZ1bmN0aW9uLnNlbnQgaW1wbGVtZW50YXRpb24uXG4gICAgICAgICAgY29udGV4dC5zZW50ID0gY29udGV4dC5fc2VudCA9IGNvbnRleHQuYXJnO1xuXG4gICAgICAgIH0gZWxzZSBpZiAoY29udGV4dC5tZXRob2QgPT09IFwidGhyb3dcIikge1xuICAgICAgICAgIGlmIChzdGF0ZSA9PT0gR2VuU3RhdGVTdXNwZW5kZWRTdGFydCkge1xuICAgICAgICAgICAgc3RhdGUgPSBHZW5TdGF0ZUNvbXBsZXRlZDtcbiAgICAgICAgICAgIHRocm93IGNvbnRleHQuYXJnO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnRleHQuZGlzcGF0Y2hFeGNlcHRpb24oY29udGV4dC5hcmcpO1xuXG4gICAgICAgIH0gZWxzZSBpZiAoY29udGV4dC5tZXRob2QgPT09IFwicmV0dXJuXCIpIHtcbiAgICAgICAgICBjb250ZXh0LmFicnVwdChcInJldHVyblwiLCBjb250ZXh0LmFyZyk7XG4gICAgICAgIH1cblxuICAgICAgICBzdGF0ZSA9IEdlblN0YXRlRXhlY3V0aW5nO1xuXG4gICAgICAgIHZhciByZWNvcmQgPSB0cnlDYXRjaChpbm5lckZuLCBzZWxmLCBjb250ZXh0KTtcbiAgICAgICAgaWYgKHJlY29yZC50eXBlID09PSBcIm5vcm1hbFwiKSB7XG4gICAgICAgICAgLy8gSWYgYW4gZXhjZXB0aW9uIGlzIHRocm93biBmcm9tIGlubmVyRm4sIHdlIGxlYXZlIHN0YXRlID09PVxuICAgICAgICAgIC8vIEdlblN0YXRlRXhlY3V0aW5nIGFuZCBsb29wIGJhY2sgZm9yIGFub3RoZXIgaW52b2NhdGlvbi5cbiAgICAgICAgICBzdGF0ZSA9IGNvbnRleHQuZG9uZVxuICAgICAgICAgICAgPyBHZW5TdGF0ZUNvbXBsZXRlZFxuICAgICAgICAgICAgOiBHZW5TdGF0ZVN1c3BlbmRlZFlpZWxkO1xuXG4gICAgICAgICAgaWYgKHJlY29yZC5hcmcgPT09IENvbnRpbnVlU2VudGluZWwpIHtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICB2YWx1ZTogcmVjb3JkLmFyZyxcbiAgICAgICAgICAgIGRvbmU6IGNvbnRleHQuZG9uZVxuICAgICAgICAgIH07XG5cbiAgICAgICAgfSBlbHNlIGlmIChyZWNvcmQudHlwZSA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICAgICAgc3RhdGUgPSBHZW5TdGF0ZUNvbXBsZXRlZDtcbiAgICAgICAgICAvLyBEaXNwYXRjaCB0aGUgZXhjZXB0aW9uIGJ5IGxvb3BpbmcgYmFjayBhcm91bmQgdG8gdGhlXG4gICAgICAgICAgLy8gY29udGV4dC5kaXNwYXRjaEV4Y2VwdGlvbihjb250ZXh0LmFyZykgY2FsbCBhYm92ZS5cbiAgICAgICAgICBjb250ZXh0Lm1ldGhvZCA9IFwidGhyb3dcIjtcbiAgICAgICAgICBjb250ZXh0LmFyZyA9IHJlY29yZC5hcmc7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuICB9XG5cbiAgLy8gQ2FsbCBkZWxlZ2F0ZS5pdGVyYXRvcltjb250ZXh0Lm1ldGhvZF0oY29udGV4dC5hcmcpIGFuZCBoYW5kbGUgdGhlXG4gIC8vIHJlc3VsdCwgZWl0aGVyIGJ5IHJldHVybmluZyBhIHsgdmFsdWUsIGRvbmUgfSByZXN1bHQgZnJvbSB0aGVcbiAgLy8gZGVsZWdhdGUgaXRlcmF0b3IsIG9yIGJ5IG1vZGlmeWluZyBjb250ZXh0Lm1ldGhvZCBhbmQgY29udGV4dC5hcmcsXG4gIC8vIHNldHRpbmcgY29udGV4dC5kZWxlZ2F0ZSB0byBudWxsLCBhbmQgcmV0dXJuaW5nIHRoZSBDb250aW51ZVNlbnRpbmVsLlxuICBmdW5jdGlvbiBtYXliZUludm9rZURlbGVnYXRlKGRlbGVnYXRlLCBjb250ZXh0KSB7XG4gICAgdmFyIG1ldGhvZCA9IGRlbGVnYXRlLml0ZXJhdG9yW2NvbnRleHQubWV0aG9kXTtcbiAgICBpZiAobWV0aG9kID09PSB1bmRlZmluZWQpIHtcbiAgICAgIC8vIEEgLnRocm93IG9yIC5yZXR1cm4gd2hlbiB0aGUgZGVsZWdhdGUgaXRlcmF0b3IgaGFzIG5vIC50aHJvd1xuICAgICAgLy8gbWV0aG9kIGFsd2F5cyB0ZXJtaW5hdGVzIHRoZSB5aWVsZCogbG9vcC5cbiAgICAgIGNvbnRleHQuZGVsZWdhdGUgPSBudWxsO1xuXG4gICAgICBpZiAoY29udGV4dC5tZXRob2QgPT09IFwidGhyb3dcIikge1xuICAgICAgICAvLyBOb3RlOiBbXCJyZXR1cm5cIl0gbXVzdCBiZSB1c2VkIGZvciBFUzMgcGFyc2luZyBjb21wYXRpYmlsaXR5LlxuICAgICAgICBpZiAoZGVsZWdhdGUuaXRlcmF0b3JbXCJyZXR1cm5cIl0pIHtcbiAgICAgICAgICAvLyBJZiB0aGUgZGVsZWdhdGUgaXRlcmF0b3IgaGFzIGEgcmV0dXJuIG1ldGhvZCwgZ2l2ZSBpdCBhXG4gICAgICAgICAgLy8gY2hhbmNlIHRvIGNsZWFuIHVwLlxuICAgICAgICAgIGNvbnRleHQubWV0aG9kID0gXCJyZXR1cm5cIjtcbiAgICAgICAgICBjb250ZXh0LmFyZyA9IHVuZGVmaW5lZDtcbiAgICAgICAgICBtYXliZUludm9rZURlbGVnYXRlKGRlbGVnYXRlLCBjb250ZXh0KTtcblxuICAgICAgICAgIGlmIChjb250ZXh0Lm1ldGhvZCA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICAgICAgICAvLyBJZiBtYXliZUludm9rZURlbGVnYXRlKGNvbnRleHQpIGNoYW5nZWQgY29udGV4dC5tZXRob2QgZnJvbVxuICAgICAgICAgICAgLy8gXCJyZXR1cm5cIiB0byBcInRocm93XCIsIGxldCB0aGF0IG92ZXJyaWRlIHRoZSBUeXBlRXJyb3IgYmVsb3cuXG4gICAgICAgICAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb250ZXh0Lm1ldGhvZCA9IFwidGhyb3dcIjtcbiAgICAgICAgY29udGV4dC5hcmcgPSBuZXcgVHlwZUVycm9yKFxuICAgICAgICAgIFwiVGhlIGl0ZXJhdG9yIGRvZXMgbm90IHByb3ZpZGUgYSAndGhyb3cnIG1ldGhvZFwiKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIENvbnRpbnVlU2VudGluZWw7XG4gICAgfVxuXG4gICAgdmFyIHJlY29yZCA9IHRyeUNhdGNoKG1ldGhvZCwgZGVsZWdhdGUuaXRlcmF0b3IsIGNvbnRleHQuYXJnKTtcblxuICAgIGlmIChyZWNvcmQudHlwZSA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICBjb250ZXh0Lm1ldGhvZCA9IFwidGhyb3dcIjtcbiAgICAgIGNvbnRleHQuYXJnID0gcmVjb3JkLmFyZztcbiAgICAgIGNvbnRleHQuZGVsZWdhdGUgPSBudWxsO1xuICAgICAgcmV0dXJuIENvbnRpbnVlU2VudGluZWw7XG4gICAgfVxuXG4gICAgdmFyIGluZm8gPSByZWNvcmQuYXJnO1xuXG4gICAgaWYgKCEgaW5mbykge1xuICAgICAgY29udGV4dC5tZXRob2QgPSBcInRocm93XCI7XG4gICAgICBjb250ZXh0LmFyZyA9IG5ldyBUeXBlRXJyb3IoXCJpdGVyYXRvciByZXN1bHQgaXMgbm90IGFuIG9iamVjdFwiKTtcbiAgICAgIGNvbnRleHQuZGVsZWdhdGUgPSBudWxsO1xuICAgICAgcmV0dXJuIENvbnRpbnVlU2VudGluZWw7XG4gICAgfVxuXG4gICAgaWYgKGluZm8uZG9uZSkge1xuICAgICAgLy8gQXNzaWduIHRoZSByZXN1bHQgb2YgdGhlIGZpbmlzaGVkIGRlbGVnYXRlIHRvIHRoZSB0ZW1wb3JhcnlcbiAgICAgIC8vIHZhcmlhYmxlIHNwZWNpZmllZCBieSBkZWxlZ2F0ZS5yZXN1bHROYW1lIChzZWUgZGVsZWdhdGVZaWVsZCkuXG4gICAgICBjb250ZXh0W2RlbGVnYXRlLnJlc3VsdE5hbWVdID0gaW5mby52YWx1ZTtcblxuICAgICAgLy8gUmVzdW1lIGV4ZWN1dGlvbiBhdCB0aGUgZGVzaXJlZCBsb2NhdGlvbiAoc2VlIGRlbGVnYXRlWWllbGQpLlxuICAgICAgY29udGV4dC5uZXh0ID0gZGVsZWdhdGUubmV4dExvYztcblxuICAgICAgLy8gSWYgY29udGV4dC5tZXRob2Qgd2FzIFwidGhyb3dcIiBidXQgdGhlIGRlbGVnYXRlIGhhbmRsZWQgdGhlXG4gICAgICAvLyBleGNlcHRpb24sIGxldCB0aGUgb3V0ZXIgZ2VuZXJhdG9yIHByb2NlZWQgbm9ybWFsbHkuIElmXG4gICAgICAvLyBjb250ZXh0Lm1ldGhvZCB3YXMgXCJuZXh0XCIsIGZvcmdldCBjb250ZXh0LmFyZyBzaW5jZSBpdCBoYXMgYmVlblxuICAgICAgLy8gXCJjb25zdW1lZFwiIGJ5IHRoZSBkZWxlZ2F0ZSBpdGVyYXRvci4gSWYgY29udGV4dC5tZXRob2Qgd2FzXG4gICAgICAvLyBcInJldHVyblwiLCBhbGxvdyB0aGUgb3JpZ2luYWwgLnJldHVybiBjYWxsIHRvIGNvbnRpbnVlIGluIHRoZVxuICAgICAgLy8gb3V0ZXIgZ2VuZXJhdG9yLlxuICAgICAgaWYgKGNvbnRleHQubWV0aG9kICE9PSBcInJldHVyblwiKSB7XG4gICAgICAgIGNvbnRleHQubWV0aG9kID0gXCJuZXh0XCI7XG4gICAgICAgIGNvbnRleHQuYXJnID0gdW5kZWZpbmVkO1xuICAgICAgfVxuXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFJlLXlpZWxkIHRoZSByZXN1bHQgcmV0dXJuZWQgYnkgdGhlIGRlbGVnYXRlIG1ldGhvZC5cbiAgICAgIHJldHVybiBpbmZvO1xuICAgIH1cblxuICAgIC8vIFRoZSBkZWxlZ2F0ZSBpdGVyYXRvciBpcyBmaW5pc2hlZCwgc28gZm9yZ2V0IGl0IGFuZCBjb250aW51ZSB3aXRoXG4gICAgLy8gdGhlIG91dGVyIGdlbmVyYXRvci5cbiAgICBjb250ZXh0LmRlbGVnYXRlID0gbnVsbDtcbiAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgfVxuXG4gIC8vIERlZmluZSBHZW5lcmF0b3IucHJvdG90eXBlLntuZXh0LHRocm93LHJldHVybn0gaW4gdGVybXMgb2YgdGhlXG4gIC8vIHVuaWZpZWQgLl9pbnZva2UgaGVscGVyIG1ldGhvZC5cbiAgZGVmaW5lSXRlcmF0b3JNZXRob2RzKEdwKTtcblxuICBHcFt0b1N0cmluZ1RhZ1N5bWJvbF0gPSBcIkdlbmVyYXRvclwiO1xuXG4gIC8vIEEgR2VuZXJhdG9yIHNob3VsZCBhbHdheXMgcmV0dXJuIGl0c2VsZiBhcyB0aGUgaXRlcmF0b3Igb2JqZWN0IHdoZW4gdGhlXG4gIC8vIEBAaXRlcmF0b3IgZnVuY3Rpb24gaXMgY2FsbGVkIG9uIGl0LiBTb21lIGJyb3dzZXJzJyBpbXBsZW1lbnRhdGlvbnMgb2YgdGhlXG4gIC8vIGl0ZXJhdG9yIHByb3RvdHlwZSBjaGFpbiBpbmNvcnJlY3RseSBpbXBsZW1lbnQgdGhpcywgY2F1c2luZyB0aGUgR2VuZXJhdG9yXG4gIC8vIG9iamVjdCB0byBub3QgYmUgcmV0dXJuZWQgZnJvbSB0aGlzIGNhbGwuIFRoaXMgZW5zdXJlcyB0aGF0IGRvZXNuJ3QgaGFwcGVuLlxuICAvLyBTZWUgaHR0cHM6Ly9naXRodWIuY29tL2ZhY2Vib29rL3JlZ2VuZXJhdG9yL2lzc3Vlcy8yNzQgZm9yIG1vcmUgZGV0YWlscy5cbiAgR3BbaXRlcmF0b3JTeW1ib2xdID0gZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH07XG5cbiAgR3AudG9TdHJpbmcgPSBmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gXCJbb2JqZWN0IEdlbmVyYXRvcl1cIjtcbiAgfTtcblxuICBmdW5jdGlvbiBwdXNoVHJ5RW50cnkobG9jcykge1xuICAgIHZhciBlbnRyeSA9IHsgdHJ5TG9jOiBsb2NzWzBdIH07XG5cbiAgICBpZiAoMSBpbiBsb2NzKSB7XG4gICAgICBlbnRyeS5jYXRjaExvYyA9IGxvY3NbMV07XG4gICAgfVxuXG4gICAgaWYgKDIgaW4gbG9jcykge1xuICAgICAgZW50cnkuZmluYWxseUxvYyA9IGxvY3NbMl07XG4gICAgICBlbnRyeS5hZnRlckxvYyA9IGxvY3NbM107XG4gICAgfVxuXG4gICAgdGhpcy50cnlFbnRyaWVzLnB1c2goZW50cnkpO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVzZXRUcnlFbnRyeShlbnRyeSkge1xuICAgIHZhciByZWNvcmQgPSBlbnRyeS5jb21wbGV0aW9uIHx8IHt9O1xuICAgIHJlY29yZC50eXBlID0gXCJub3JtYWxcIjtcbiAgICBkZWxldGUgcmVjb3JkLmFyZztcbiAgICBlbnRyeS5jb21wbGV0aW9uID0gcmVjb3JkO1xuICB9XG5cbiAgZnVuY3Rpb24gQ29udGV4dCh0cnlMb2NzTGlzdCkge1xuICAgIC8vIFRoZSByb290IGVudHJ5IG9iamVjdCAoZWZmZWN0aXZlbHkgYSB0cnkgc3RhdGVtZW50IHdpdGhvdXQgYSBjYXRjaFxuICAgIC8vIG9yIGEgZmluYWxseSBibG9jaykgZ2l2ZXMgdXMgYSBwbGFjZSB0byBzdG9yZSB2YWx1ZXMgdGhyb3duIGZyb21cbiAgICAvLyBsb2NhdGlvbnMgd2hlcmUgdGhlcmUgaXMgbm8gZW5jbG9zaW5nIHRyeSBzdGF0ZW1lbnQuXG4gICAgdGhpcy50cnlFbnRyaWVzID0gW3sgdHJ5TG9jOiBcInJvb3RcIiB9XTtcbiAgICB0cnlMb2NzTGlzdC5mb3JFYWNoKHB1c2hUcnlFbnRyeSwgdGhpcyk7XG4gICAgdGhpcy5yZXNldCh0cnVlKTtcbiAgfVxuXG4gIGV4cG9ydHMua2V5cyA9IGZ1bmN0aW9uKG9iamVjdCkge1xuICAgIHZhciBrZXlzID0gW107XG4gICAgZm9yICh2YXIga2V5IGluIG9iamVjdCkge1xuICAgICAga2V5cy5wdXNoKGtleSk7XG4gICAgfVxuICAgIGtleXMucmV2ZXJzZSgpO1xuXG4gICAgLy8gUmF0aGVyIHRoYW4gcmV0dXJuaW5nIGFuIG9iamVjdCB3aXRoIGEgbmV4dCBtZXRob2QsIHdlIGtlZXBcbiAgICAvLyB0aGluZ3Mgc2ltcGxlIGFuZCByZXR1cm4gdGhlIG5leHQgZnVuY3Rpb24gaXRzZWxmLlxuICAgIHJldHVybiBmdW5jdGlvbiBuZXh0KCkge1xuICAgICAgd2hpbGUgKGtleXMubGVuZ3RoKSB7XG4gICAgICAgIHZhciBrZXkgPSBrZXlzLnBvcCgpO1xuICAgICAgICBpZiAoa2V5IGluIG9iamVjdCkge1xuICAgICAgICAgIG5leHQudmFsdWUgPSBrZXk7XG4gICAgICAgICAgbmV4dC5kb25lID0gZmFsc2U7XG4gICAgICAgICAgcmV0dXJuIG5leHQ7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gVG8gYXZvaWQgY3JlYXRpbmcgYW4gYWRkaXRpb25hbCBvYmplY3QsIHdlIGp1c3QgaGFuZyB0aGUgLnZhbHVlXG4gICAgICAvLyBhbmQgLmRvbmUgcHJvcGVydGllcyBvZmYgdGhlIG5leHQgZnVuY3Rpb24gb2JqZWN0IGl0c2VsZi4gVGhpc1xuICAgICAgLy8gYWxzbyBlbnN1cmVzIHRoYXQgdGhlIG1pbmlmaWVyIHdpbGwgbm90IGFub255bWl6ZSB0aGUgZnVuY3Rpb24uXG4gICAgICBuZXh0LmRvbmUgPSB0cnVlO1xuICAgICAgcmV0dXJuIG5leHQ7XG4gICAgfTtcbiAgfTtcblxuICBmdW5jdGlvbiB2YWx1ZXMoaXRlcmFibGUpIHtcbiAgICBpZiAoaXRlcmFibGUpIHtcbiAgICAgIHZhciBpdGVyYXRvck1ldGhvZCA9IGl0ZXJhYmxlW2l0ZXJhdG9yU3ltYm9sXTtcbiAgICAgIGlmIChpdGVyYXRvck1ldGhvZCkge1xuICAgICAgICByZXR1cm4gaXRlcmF0b3JNZXRob2QuY2FsbChpdGVyYWJsZSk7XG4gICAgICB9XG5cbiAgICAgIGlmICh0eXBlb2YgaXRlcmFibGUubmV4dCA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgIHJldHVybiBpdGVyYWJsZTtcbiAgICAgIH1cblxuICAgICAgaWYgKCFpc05hTihpdGVyYWJsZS5sZW5ndGgpKSB7XG4gICAgICAgIHZhciBpID0gLTEsIG5leHQgPSBmdW5jdGlvbiBuZXh0KCkge1xuICAgICAgICAgIHdoaWxlICgrK2kgPCBpdGVyYWJsZS5sZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChoYXNPd24uY2FsbChpdGVyYWJsZSwgaSkpIHtcbiAgICAgICAgICAgICAgbmV4dC52YWx1ZSA9IGl0ZXJhYmxlW2ldO1xuICAgICAgICAgICAgICBuZXh0LmRvbmUgPSBmYWxzZTtcbiAgICAgICAgICAgICAgcmV0dXJuIG5leHQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgbmV4dC52YWx1ZSA9IHVuZGVmaW5lZDtcbiAgICAgICAgICBuZXh0LmRvbmUgPSB0cnVlO1xuXG4gICAgICAgICAgcmV0dXJuIG5leHQ7XG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIG5leHQubmV4dCA9IG5leHQ7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUmV0dXJuIGFuIGl0ZXJhdG9yIHdpdGggbm8gdmFsdWVzLlxuICAgIHJldHVybiB7IG5leHQ6IGRvbmVSZXN1bHQgfTtcbiAgfVxuICBleHBvcnRzLnZhbHVlcyA9IHZhbHVlcztcblxuICBmdW5jdGlvbiBkb25lUmVzdWx0KCkge1xuICAgIHJldHVybiB7IHZhbHVlOiB1bmRlZmluZWQsIGRvbmU6IHRydWUgfTtcbiAgfVxuXG4gIENvbnRleHQucHJvdG90eXBlID0ge1xuICAgIGNvbnN0cnVjdG9yOiBDb250ZXh0LFxuXG4gICAgcmVzZXQ6IGZ1bmN0aW9uKHNraXBUZW1wUmVzZXQpIHtcbiAgICAgIHRoaXMucHJldiA9IDA7XG4gICAgICB0aGlzLm5leHQgPSAwO1xuICAgICAgLy8gUmVzZXR0aW5nIGNvbnRleHQuX3NlbnQgZm9yIGxlZ2FjeSBzdXBwb3J0IG9mIEJhYmVsJ3NcbiAgICAgIC8vIGZ1bmN0aW9uLnNlbnQgaW1wbGVtZW50YXRpb24uXG4gICAgICB0aGlzLnNlbnQgPSB0aGlzLl9zZW50ID0gdW5kZWZpbmVkO1xuICAgICAgdGhpcy5kb25lID0gZmFsc2U7XG4gICAgICB0aGlzLmRlbGVnYXRlID0gbnVsbDtcblxuICAgICAgdGhpcy5tZXRob2QgPSBcIm5leHRcIjtcbiAgICAgIHRoaXMuYXJnID0gdW5kZWZpbmVkO1xuXG4gICAgICB0aGlzLnRyeUVudHJpZXMuZm9yRWFjaChyZXNldFRyeUVudHJ5KTtcblxuICAgICAgaWYgKCFza2lwVGVtcFJlc2V0KSB7XG4gICAgICAgIGZvciAodmFyIG5hbWUgaW4gdGhpcykge1xuICAgICAgICAgIC8vIE5vdCBzdXJlIGFib3V0IHRoZSBvcHRpbWFsIG9yZGVyIG9mIHRoZXNlIGNvbmRpdGlvbnM6XG4gICAgICAgICAgaWYgKG5hbWUuY2hhckF0KDApID09PSBcInRcIiAmJlxuICAgICAgICAgICAgICBoYXNPd24uY2FsbCh0aGlzLCBuYW1lKSAmJlxuICAgICAgICAgICAgICAhaXNOYU4oK25hbWUuc2xpY2UoMSkpKSB7XG4gICAgICAgICAgICB0aGlzW25hbWVdID0gdW5kZWZpbmVkO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0sXG5cbiAgICBzdG9wOiBmdW5jdGlvbigpIHtcbiAgICAgIHRoaXMuZG9uZSA9IHRydWU7XG5cbiAgICAgIHZhciByb290RW50cnkgPSB0aGlzLnRyeUVudHJpZXNbMF07XG4gICAgICB2YXIgcm9vdFJlY29yZCA9IHJvb3RFbnRyeS5jb21wbGV0aW9uO1xuICAgICAgaWYgKHJvb3RSZWNvcmQudHlwZSA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICAgIHRocm93IHJvb3RSZWNvcmQuYXJnO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcy5ydmFsO1xuICAgIH0sXG5cbiAgICBkaXNwYXRjaEV4Y2VwdGlvbjogZnVuY3Rpb24oZXhjZXB0aW9uKSB7XG4gICAgICBpZiAodGhpcy5kb25lKSB7XG4gICAgICAgIHRocm93IGV4Y2VwdGlvbjtcbiAgICAgIH1cblxuICAgICAgdmFyIGNvbnRleHQgPSB0aGlzO1xuICAgICAgZnVuY3Rpb24gaGFuZGxlKGxvYywgY2F1Z2h0KSB7XG4gICAgICAgIHJlY29yZC50eXBlID0gXCJ0aHJvd1wiO1xuICAgICAgICByZWNvcmQuYXJnID0gZXhjZXB0aW9uO1xuICAgICAgICBjb250ZXh0Lm5leHQgPSBsb2M7XG5cbiAgICAgICAgaWYgKGNhdWdodCkge1xuICAgICAgICAgIC8vIElmIHRoZSBkaXNwYXRjaGVkIGV4Y2VwdGlvbiB3YXMgY2F1Z2h0IGJ5IGEgY2F0Y2ggYmxvY2ssXG4gICAgICAgICAgLy8gdGhlbiBsZXQgdGhhdCBjYXRjaCBibG9jayBoYW5kbGUgdGhlIGV4Y2VwdGlvbiBub3JtYWxseS5cbiAgICAgICAgICBjb250ZXh0Lm1ldGhvZCA9IFwibmV4dFwiO1xuICAgICAgICAgIGNvbnRleHQuYXJnID0gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICEhIGNhdWdodDtcbiAgICAgIH1cblxuICAgICAgZm9yICh2YXIgaSA9IHRoaXMudHJ5RW50cmllcy5sZW5ndGggLSAxOyBpID49IDA7IC0taSkge1xuICAgICAgICB2YXIgZW50cnkgPSB0aGlzLnRyeUVudHJpZXNbaV07XG4gICAgICAgIHZhciByZWNvcmQgPSBlbnRyeS5jb21wbGV0aW9uO1xuXG4gICAgICAgIGlmIChlbnRyeS50cnlMb2MgPT09IFwicm9vdFwiKSB7XG4gICAgICAgICAgLy8gRXhjZXB0aW9uIHRocm93biBvdXRzaWRlIG9mIGFueSB0cnkgYmxvY2sgdGhhdCBjb3VsZCBoYW5kbGVcbiAgICAgICAgICAvLyBpdCwgc28gc2V0IHRoZSBjb21wbGV0aW9uIHZhbHVlIG9mIHRoZSBlbnRpcmUgZnVuY3Rpb24gdG9cbiAgICAgICAgICAvLyB0aHJvdyB0aGUgZXhjZXB0aW9uLlxuICAgICAgICAgIHJldHVybiBoYW5kbGUoXCJlbmRcIik7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZW50cnkudHJ5TG9jIDw9IHRoaXMucHJldikge1xuICAgICAgICAgIHZhciBoYXNDYXRjaCA9IGhhc093bi5jYWxsKGVudHJ5LCBcImNhdGNoTG9jXCIpO1xuICAgICAgICAgIHZhciBoYXNGaW5hbGx5ID0gaGFzT3duLmNhbGwoZW50cnksIFwiZmluYWxseUxvY1wiKTtcblxuICAgICAgICAgIGlmIChoYXNDYXRjaCAmJiBoYXNGaW5hbGx5KSB7XG4gICAgICAgICAgICBpZiAodGhpcy5wcmV2IDwgZW50cnkuY2F0Y2hMb2MpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIGhhbmRsZShlbnRyeS5jYXRjaExvYywgdHJ1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMucHJldiA8IGVudHJ5LmZpbmFsbHlMb2MpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIGhhbmRsZShlbnRyeS5maW5hbGx5TG9jKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgIH0gZWxzZSBpZiAoaGFzQ2F0Y2gpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLnByZXYgPCBlbnRyeS5jYXRjaExvYykge1xuICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlKGVudHJ5LmNhdGNoTG9jLCB0cnVlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgIH0gZWxzZSBpZiAoaGFzRmluYWxseSkge1xuICAgICAgICAgICAgaWYgKHRoaXMucHJldiA8IGVudHJ5LmZpbmFsbHlMb2MpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIGhhbmRsZShlbnRyeS5maW5hbGx5TG9jKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ0cnkgc3RhdGVtZW50IHdpdGhvdXQgY2F0Y2ggb3IgZmluYWxseVwiKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9LFxuXG4gICAgYWJydXB0OiBmdW5jdGlvbih0eXBlLCBhcmcpIHtcbiAgICAgIGZvciAodmFyIGkgPSB0aGlzLnRyeUVudHJpZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyAtLWkpIHtcbiAgICAgICAgdmFyIGVudHJ5ID0gdGhpcy50cnlFbnRyaWVzW2ldO1xuICAgICAgICBpZiAoZW50cnkudHJ5TG9jIDw9IHRoaXMucHJldiAmJlxuICAgICAgICAgICAgaGFzT3duLmNhbGwoZW50cnksIFwiZmluYWxseUxvY1wiKSAmJlxuICAgICAgICAgICAgdGhpcy5wcmV2IDwgZW50cnkuZmluYWxseUxvYykge1xuICAgICAgICAgIHZhciBmaW5hbGx5RW50cnkgPSBlbnRyeTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoZmluYWxseUVudHJ5ICYmXG4gICAgICAgICAgKHR5cGUgPT09IFwiYnJlYWtcIiB8fFxuICAgICAgICAgICB0eXBlID09PSBcImNvbnRpbnVlXCIpICYmXG4gICAgICAgICAgZmluYWxseUVudHJ5LnRyeUxvYyA8PSBhcmcgJiZcbiAgICAgICAgICBhcmcgPD0gZmluYWxseUVudHJ5LmZpbmFsbHlMb2MpIHtcbiAgICAgICAgLy8gSWdub3JlIHRoZSBmaW5hbGx5IGVudHJ5IGlmIGNvbnRyb2wgaXMgbm90IGp1bXBpbmcgdG8gYVxuICAgICAgICAvLyBsb2NhdGlvbiBvdXRzaWRlIHRoZSB0cnkvY2F0Y2ggYmxvY2suXG4gICAgICAgIGZpbmFsbHlFbnRyeSA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIHZhciByZWNvcmQgPSBmaW5hbGx5RW50cnkgPyBmaW5hbGx5RW50cnkuY29tcGxldGlvbiA6IHt9O1xuICAgICAgcmVjb3JkLnR5cGUgPSB0eXBlO1xuICAgICAgcmVjb3JkLmFyZyA9IGFyZztcblxuICAgICAgaWYgKGZpbmFsbHlFbnRyeSkge1xuICAgICAgICB0aGlzLm1ldGhvZCA9IFwibmV4dFwiO1xuICAgICAgICB0aGlzLm5leHQgPSBmaW5hbGx5RW50cnkuZmluYWxseUxvYztcbiAgICAgICAgcmV0dXJuIENvbnRpbnVlU2VudGluZWw7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB0aGlzLmNvbXBsZXRlKHJlY29yZCk7XG4gICAgfSxcblxuICAgIGNvbXBsZXRlOiBmdW5jdGlvbihyZWNvcmQsIGFmdGVyTG9jKSB7XG4gICAgICBpZiAocmVjb3JkLnR5cGUgPT09IFwidGhyb3dcIikge1xuICAgICAgICB0aHJvdyByZWNvcmQuYXJnO1xuICAgICAgfVxuXG4gICAgICBpZiAocmVjb3JkLnR5cGUgPT09IFwiYnJlYWtcIiB8fFxuICAgICAgICAgIHJlY29yZC50eXBlID09PSBcImNvbnRpbnVlXCIpIHtcbiAgICAgICAgdGhpcy5uZXh0ID0gcmVjb3JkLmFyZztcbiAgICAgIH0gZWxzZSBpZiAocmVjb3JkLnR5cGUgPT09IFwicmV0dXJuXCIpIHtcbiAgICAgICAgdGhpcy5ydmFsID0gdGhpcy5hcmcgPSByZWNvcmQuYXJnO1xuICAgICAgICB0aGlzLm1ldGhvZCA9IFwicmV0dXJuXCI7XG4gICAgICAgIHRoaXMubmV4dCA9IFwiZW5kXCI7XG4gICAgICB9IGVsc2UgaWYgKHJlY29yZC50eXBlID09PSBcIm5vcm1hbFwiICYmIGFmdGVyTG9jKSB7XG4gICAgICAgIHRoaXMubmV4dCA9IGFmdGVyTG9jO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgICB9LFxuXG4gICAgZmluaXNoOiBmdW5jdGlvbihmaW5hbGx5TG9jKSB7XG4gICAgICBmb3IgKHZhciBpID0gdGhpcy50cnlFbnRyaWVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgLS1pKSB7XG4gICAgICAgIHZhciBlbnRyeSA9IHRoaXMudHJ5RW50cmllc1tpXTtcbiAgICAgICAgaWYgKGVudHJ5LmZpbmFsbHlMb2MgPT09IGZpbmFsbHlMb2MpIHtcbiAgICAgICAgICB0aGlzLmNvbXBsZXRlKGVudHJ5LmNvbXBsZXRpb24sIGVudHJ5LmFmdGVyTG9jKTtcbiAgICAgICAgICByZXNldFRyeUVudHJ5KGVudHJ5KTtcbiAgICAgICAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0sXG5cbiAgICBcImNhdGNoXCI6IGZ1bmN0aW9uKHRyeUxvYykge1xuICAgICAgZm9yICh2YXIgaSA9IHRoaXMudHJ5RW50cmllcy5sZW5ndGggLSAxOyBpID49IDA7IC0taSkge1xuICAgICAgICB2YXIgZW50cnkgPSB0aGlzLnRyeUVudHJpZXNbaV07XG4gICAgICAgIGlmIChlbnRyeS50cnlMb2MgPT09IHRyeUxvYykge1xuICAgICAgICAgIHZhciByZWNvcmQgPSBlbnRyeS5jb21wbGV0aW9uO1xuICAgICAgICAgIGlmIChyZWNvcmQudHlwZSA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICAgICAgICB2YXIgdGhyb3duID0gcmVjb3JkLmFyZztcbiAgICAgICAgICAgIHJlc2V0VHJ5RW50cnkoZW50cnkpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gdGhyb3duO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFRoZSBjb250ZXh0LmNhdGNoIG1ldGhvZCBtdXN0IG9ubHkgYmUgY2FsbGVkIHdpdGggYSBsb2NhdGlvblxuICAgICAgLy8gYXJndW1lbnQgdGhhdCBjb3JyZXNwb25kcyB0byBhIGtub3duIGNhdGNoIGJsb2NrLlxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiaWxsZWdhbCBjYXRjaCBhdHRlbXB0XCIpO1xuICAgIH0sXG5cbiAgICBkZWxlZ2F0ZVlpZWxkOiBmdW5jdGlvbihpdGVyYWJsZSwgcmVzdWx0TmFtZSwgbmV4dExvYykge1xuICAgICAgdGhpcy5kZWxlZ2F0ZSA9IHtcbiAgICAgICAgaXRlcmF0b3I6IHZhbHVlcyhpdGVyYWJsZSksXG4gICAgICAgIHJlc3VsdE5hbWU6IHJlc3VsdE5hbWUsXG4gICAgICAgIG5leHRMb2M6IG5leHRMb2NcbiAgICAgIH07XG5cbiAgICAgIGlmICh0aGlzLm1ldGhvZCA9PT0gXCJuZXh0XCIpIHtcbiAgICAgICAgLy8gRGVsaWJlcmF0ZWx5IGZvcmdldCB0aGUgbGFzdCBzZW50IHZhbHVlIHNvIHRoYXQgd2UgZG9uJ3RcbiAgICAgICAgLy8gYWNjaWRlbnRhbGx5IHBhc3MgaXQgb24gdG8gdGhlIGRlbGVnYXRlLlxuICAgICAgICB0aGlzLmFyZyA9IHVuZGVmaW5lZDtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIENvbnRpbnVlU2VudGluZWw7XG4gICAgfVxuICB9O1xuXG4gIC8vIFJlZ2FyZGxlc3Mgb2Ygd2hldGhlciB0aGlzIHNjcmlwdCBpcyBleGVjdXRpbmcgYXMgYSBDb21tb25KUyBtb2R1bGVcbiAgLy8gb3Igbm90LCByZXR1cm4gdGhlIHJ1bnRpbWUgb2JqZWN0IHNvIHRoYXQgd2UgY2FuIGRlY2xhcmUgdGhlIHZhcmlhYmxlXG4gIC8vIHJlZ2VuZXJhdG9yUnVudGltZSBpbiB0aGUgb3V0ZXIgc2NvcGUsIHdoaWNoIGFsbG93cyB0aGlzIG1vZHVsZSB0byBiZVxuICAvLyBpbmplY3RlZCBlYXNpbHkgYnkgYGJpbi9yZWdlbmVyYXRvciAtLWluY2x1ZGUtcnVudGltZSBzY3JpcHQuanNgLlxuICByZXR1cm4gZXhwb3J0cztcblxufShcbiAgLy8gSWYgdGhpcyBzY3JpcHQgaXMgZXhlY3V0aW5nIGFzIGEgQ29tbW9uSlMgbW9kdWxlLCB1c2UgbW9kdWxlLmV4cG9ydHNcbiAgLy8gYXMgdGhlIHJlZ2VuZXJhdG9yUnVudGltZSBuYW1lc3BhY2UuIE90aGVyd2lzZSBjcmVhdGUgYSBuZXcgZW1wdHlcbiAgLy8gb2JqZWN0LiBFaXRoZXIgd2F5LCB0aGUgcmVzdWx0aW5nIG9iamVjdCB3aWxsIGJlIHVzZWQgdG8gaW5pdGlhbGl6ZVxuICAvLyB0aGUgcmVnZW5lcmF0b3JSdW50aW1lIHZhcmlhYmxlIGF0IHRoZSB0b3Agb2YgdGhpcyBmaWxlLlxuICB0eXBlb2YgbW9kdWxlID09PSBcIm9iamVjdFwiID8gbW9kdWxlLmV4cG9ydHMgOiB7fVxuKSk7XG5cbnRyeSB7XG4gIHJlZ2VuZXJhdG9yUnVudGltZSA9IHJ1bnRpbWU7XG59IGNhdGNoIChhY2NpZGVudGFsU3RyaWN0TW9kZSkge1xuICAvLyBUaGlzIG1vZHVsZSBzaG91bGQgbm90IGJlIHJ1bm5pbmcgaW4gc3RyaWN0IG1vZGUsIHNvIHRoZSBhYm92ZVxuICAvLyBhc3NpZ25tZW50IHNob3VsZCBhbHdheXMgd29yayB1bmxlc3Mgc29tZXRoaW5nIGlzIG1pc2NvbmZpZ3VyZWQuIEp1c3RcbiAgLy8gaW4gY2FzZSBydW50aW1lLmpzIGFjY2lkZW50YWxseSBydW5zIGluIHN0cmljdCBtb2RlLCB3ZSBjYW4gZXNjYXBlXG4gIC8vIHN0cmljdCBtb2RlIHVzaW5nIGEgZ2xvYmFsIEZ1bmN0aW9uIGNhbGwuIFRoaXMgY291bGQgY29uY2VpdmFibHkgZmFpbFxuICAvLyBpZiBhIENvbnRlbnQgU2VjdXJpdHkgUG9saWN5IGZvcmJpZHMgdXNpbmcgRnVuY3Rpb24sIGJ1dCBpbiB0aGF0IGNhc2VcbiAgLy8gdGhlIHByb3BlciBzb2x1dGlvbiBpcyB0byBmaXggdGhlIGFjY2lkZW50YWwgc3RyaWN0IG1vZGUgcHJvYmxlbS4gSWZcbiAgLy8geW91J3ZlIG1pc2NvbmZpZ3VyZWQgeW91ciBidW5kbGVyIHRvIGZvcmNlIHN0cmljdCBtb2RlIGFuZCBhcHBsaWVkIGFcbiAgLy8gQ1NQIHRvIGZvcmJpZCBGdW5jdGlvbiwgYW5kIHlvdSdyZSBub3Qgd2lsbGluZyB0byBmaXggZWl0aGVyIG9mIHRob3NlXG4gIC8vIHByb2JsZW1zLCBwbGVhc2UgZGV0YWlsIHlvdXIgdW5pcXVlIHByZWRpY2FtZW50IGluIGEgR2l0SHViIGlzc3VlLlxuICBGdW5jdGlvbihcInJcIiwgXCJyZWdlbmVyYXRvclJ1bnRpbWUgPSByXCIpKHJ1bnRpbWUpO1xufVxuIiwiY29uc3QgcmVnZW5lcmF0b3JSdW50aW1lID0gcmVxdWlyZShcInJlZ2VuZXJhdG9yLXJ1bnRpbWVcIik7XHJcblxyXG5jb25zdCB0b3BsaW5lID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIi5tZW51XCIpO1xyXG5jb25zdCBtb2JpbGVNZW51ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtb2JpbGVNZW51XCIpO1xyXG5jb25zdCBjbG9zZUJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiY2xvc2VCdG5cIik7XHJcbmNvbnN0IGJ1cmdlciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiYnVyZ2VyXCIpO1xyXG5jb25zdCBtb2JpbGVMaXN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtb2JpbGVMaXN0XCIpO1xyXG5jb25zdCBzZWVNb3JlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzZWVNb3JlXCIpO1xyXG5jb25zdCBhY2NvcmRlb24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImFjY29yZGVvblwiKTtcclxuY29uc3QgcmVhZE1vcmUxID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJyZWFkTW9yZTFcIik7XHJcbmNvbnN0IGxpc3RGaXJzdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibGlzdEZpcnN0XCIpO1xyXG5jb25zdCB0ZXh0Rmlyc3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRleHRGaXJzdFwiKTtcclxuY29uc3QgdGV4dFNlY29uZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwidGV4dFNlY29uZFwiKTtcclxubGV0IGNvdW50ZXIgPSAzO1xyXG5sZXQgcmFpc2VyID0gMztcclxuY29uc3QgcHJvZHVjdHMgPSBbXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy8xLiBJbmRvb3IuanBnXCIsXHJcbiAgICBzdWJ0aXRsZTogXCJJbmRvb3IgZW5lcmd5IHNlcnZpY2VzXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGhlbHBlZCBJbmRvb3IgZW5lcmd5IHNlcnZpY2VzIHRvIGdyZWF0eSBzaW1wbGlmeSB0aGVpciBjYXNlIG1hbmFnZW1lbnQgc3lzdGVtLi4uXCJcclxuICB9LFxyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvMi4gQmlyZGllLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiQmlyZGllIEdvbGQgVG91cnNcIixcclxuICAgIHRleHQ6XHJcbiAgICAgIFwiV2UgaGVscGVkIEJpcmR5IEdvbGYgVG91cnMgdG8gc3RheSByZWxldmVhbnQgb24gYW4gaW5jbHJlYXNpbmdseSBjb21wZXRpdGl2ZSBtYXJrZXQuLi5cIlxyXG4gIH0sXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy8zLiBOb3dXaGVyZS5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIk5vd1doZXJlXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGJ1aWx0IGEgcmVjb21tZW5kYXRpb25zIGFwcCBmb3IgcGVvcGxlIHdvcmtpbmcgaW4gY3JlYXRpdmUgaW5kdXN0cmllcy4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nLzQuIEZ5bmRpcXN2YWpwZW4uanBnXCIsXHJcbiAgICBzdWJ0aXRsZTogXCJGeW5kaXFzdmFqcGVuXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGNyZWF0ZWQgYW4gYXBwIHRoYXQgaGVscGVkIGN1c3RvbWVycyBmaW5kIGdpZnRzIGFtb25nIG1vcmUgdGhhbiAyOTAwMDAwIGl0ZW1zLi4uXCJcclxuICB9LFxyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvNS4gQnl0aGp1bC5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIkJ5dGhqdWxcIixcclxuICAgIHRleHQ6XHJcbiAgICAgIFwiV2UgY3JlYXRlZCB0aXJlIGZhc2hpb24gZm9yIHRoZSBpbmNyZWFzaW5nbHkgZWdhbGl0YXJpYW4gY2FyIG1haW50aW5hY2UgbWFya2V0Li4uXCJcclxuICB9LFxyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvNi4gVGlja2luLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiVGlja2luXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGludmVudGVkIGEgdGltZSByZXBvcnRpbmcgc3lzdGVtIGZvciBwZW9wbGUgd2hvIGhhdGUgdGltZSB0cmFja2luZy4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nLzcuIFViZXJtZWRzLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiVWJlcm1lZHNcIixcclxuICAgIHRleHQ6XHJcbiAgICAgIFwiV2UgY3JlYXRlZCBhbiBhcHAgdGhhdCBoZWxwZWQgY3VzdG9tZXJzIGZpbmQgZ2lmdHMgYW1vbmcgbW9yZSB0aGFuIDI5MDAwMDAgaXRlbXMuLi5cIlxyXG4gIH0sXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy84LiBWw6RzdHRyYWZpayBDYWxjdWxhdG9yLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiVsOkc3R0cmFmaWsgQ2FsY3VsYXRvclwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBjcmVhdGVkIHRpcmUgZmFzaGlvbiBmb3IgdGhlIGluY3JlYXNpbmdseSBlZ2FsaXRhcmlhbiBjYXIgbWFpbnRpbmFjZSBtYXJrZXQuLi5cIlxyXG4gIH0sXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy85LiBUcsOkbmluZ3NwYXJ0bmVyLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiVHLDpG5pbmdzcGFydG5lclwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBpbnZlbnRlZCBhIHRpbWUgcmVwb3J0aW5nIHN5c3RlbSBmb3IgcGVvcGxlIHdobyBoYXRlIHRpbWUgdHJhY2tpbmcuLi5cIlxyXG4gIH1cclxuXTtcclxuXHJcbmRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxcIiwgKCkgPT4ge1xyXG4gIGlmICh3aW5kb3cucGFnZVlPZmZzZXQgPCB0b3BsaW5lLmNsaWVudEhlaWdodCkge1xyXG4gICAgdG9wbGluZS5jbGFzc0xpc3QucmVtb3ZlKFwiZml4ZWRcIik7XHJcbiAgfSBlbHNlIHtcclxuICAgIHRvcGxpbmUuY2xhc3NMaXN0LmFkZChcImZpeGVkXCIpO1xyXG4gIH1cclxufSk7XHJcblxyXG5idXJnZXIub25jbGljayA9IGUgPT4ge1xyXG4gIGUucHJldmVudERlZmF1bHQoKTtcclxuICBtb2JpbGVNZW51LmNsYXNzTGlzdC50b2dnbGUoXCJoaWRlXCIpO1xyXG59O1xyXG5cclxuY2xvc2VCdG4ub25jbGljayA9IGUgPT4ge1xyXG4gIGUucHJldmVudERlZmF1bHQoKTtcclxuICBtb2JpbGVNZW51LmNsYXNzTGlzdC50b2dnbGUoXCJoaWRlXCIpO1xyXG59O1xyXG5cclxubW9iaWxlTGlzdC5vbmNsaWNrID0gKCkgPT4ge1xyXG4gIG1vYmlsZU1lbnUuY2xhc3NMaXN0LnRvZ2dsZShcImhpZGVcIik7XHJcbn07XHJcblxyXG5hY2NvcmRlb24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZSkgPT4ge1xyXG4gIGxldCB0YXJnZXQgPSBlLnRhcmdldDtcclxuICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudHNCeUNsYXNzTmFtZSgnaG93LXdlLWRvX190YWJsZXQtaXRlbScpO1xyXG4gIGxldCBhcnIgPSBbLi4ubGlzdF1cclxuICBhcnIubWFwKGkgPT4gaS5jbGFzc0xpc3QucmVtb3ZlKCdzaG93JykpXHJcbiAgdGFyZ2V0LmNsYXNzTGlzdC5hZGQoJ3Nob3cnKTtcclxufSk7XHJcblxyXG5yZWFkTW9yZTEub25jbGljayA9IGUgPT4ge1xyXG4gIGUucHJldmVudERlZmF1bHQoKTtcclxuICBsaXN0Rmlyc3QuY2xhc3NMaXN0LmFkZChcIm1vcmVcIik7XHJcbiAgdGV4dEZpcnN0LmNsYXNzTGlzdC5hZGQoXCJtb3JlXCIpO1xyXG59O1xyXG5cclxucmVhZE1vcmUyLm9uY2xpY2sgPSBlID0+IHtcclxuICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgdGV4dFNlY29uZC5jbGFzc0xpc3QuYWRkKFwibW9yZVwiKTtcclxufTtcclxuXHJcbmNvbnN0IHJlbmRlclByb2R1Y3RzID0gaXRlbSA9PiB7XHJcbiAgcmV0dXJuIGA8ZGl2IGNsYXNzPVwiY29sLTEyIGNvbC1tZC02IGNvbC1sZy00XCI+XHJcbiAgPGRpdiBjbGFzcz1cInByb2plY3RzX19jYXJkXCI+XHJcbiAgICA8aW1nIHNyYz1cIiR7aXRlbS5zcmN9XCIgYWx0PVwibWFza1wiPlxyXG4gICAgPGRpdiBjbGFzcz1cInByb2plY3RzX19pbmZvXCI+XHJcbiAgICAgIDxoNCBjbGFzcz1cInByb2plY3RzX19zdWJ0aXRsZVwiPiR7aXRlbS5zdWJ0aXRsZX08L2g0PlxyXG4gICAgICA8cCBjbGFzcz1cInByb2plY3RzX190ZXh0XCI+JHtpdGVtLnRleHR9PC9wPlxyXG4gICAgPC9kaXY+XHJcbiAgPC9kaXY+XHJcbjwvZGl2PmA7XHJcbn07XHJcblxyXG5sZXQgcmVuZGVyU2VjdGlvbiA9IHByb2plY3RzRGF0YSA9PiB7XHJcbiAgY29uc3QgcHJvamVjdHMgPSBwcm9qZWN0c0RhdGEubWFwKGVsZW1lbnQgPT4gcmVuZGVyUHJvZHVjdHMoZWxlbWVudCkpO1xyXG4gIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicHJvamVjdHNSZW5kZXJcIikuaW5uZXJIVE1MID0gcHJvamVjdHMuam9pbihcIlwiKTtcclxufTtcclxuXHJcbnNlZU1vcmUub25jbGljayA9IGUgPT4ge1xyXG4gIGUucHJldmVudERlZmF1bHQoKTtcclxuICBjb3VudGVyICs9IHJhaXNlcjtcclxuICByZW5kZXJTZWN0aW9uKHByb2R1Y3RzLnNsaWNlKDAsIGNvdW50ZXIpKTtcclxufTtcclxuXHJcbndpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCAoKSA9PiB7XHJcbiAgY29uc3Qgd2l0ZGhDb3VudGVyID0gYXN5bmMgKCkgPT4ge1xyXG4gICAgc3dpdGNoICh0cnVlKSB7XHJcbiAgICAgIGNhc2UgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNsaWVudFdpZHRoID4gNzY4OlxyXG4gICAgICAgIGNvdW50ZXIgPSA5O1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgICBjYXNlIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5jbGllbnRXaWR0aCA+IDQxNDpcclxuICAgICAgICBjb3VudGVyID0gNDtcclxuICAgICAgICByYWlzZXIgPSA0O1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgICBkZWZhdWx0OlxyXG4gICAgICAgIGNvdW50ZXIgPSAzO1xyXG4gICAgICAgIHJhaXNlciA9IDM7XHJcbiAgICAgICAgYnJlYWs7XHJcbiAgICB9XHJcbiAgfTtcclxuICB3aXRkaENvdW50ZXIoKTtcclxuICByZW5kZXJTZWN0aW9uKHByb2R1Y3RzLnNsaWNlKDAsIGNvdW50ZXIpKTtcclxufSk7XHJcbiJdLCJwcmVFeGlzdGluZ0NvbW1lbnQiOiIvLyMgc291cmNlTWFwcGluZ1VSTD1kYXRhOmFwcGxpY2F0aW9uL2pzb247Y2hhcnNldD11dGYtODtiYXNlNjQsZXlKMlpYSnphVzl1SWpvekxDSnpiM1Z5WTJWeklqcGJJbTV2WkdWZmJXOWtkV3hsY3k5aWNtOTNjMlZ5TFhCaFkyc3ZYM0J5Wld4MVpHVXVhbk1pTENKdWIyUmxYMjF2WkhWc1pYTXZjbVZuWlc1bGNtRjBiM0l0Y25WdWRHbHRaUzl5ZFc1MGFXMWxMbXB6SWl3aWNISnZhbVZqZEhNdmQyaHBkR1Z3YjNKMExYTnBkR1V2YzNKakwycHpMMkZ3Y0M1cWN5SmRMQ0p1WVcxbGN5STZXMTBzSW0xaGNIQnBibWR6SWpvaVFVRkJRVHRCUTBGQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPenM3T3pzN096czdPenM3UVVOMGRFSkJMRWxCUVUwc2EwSkJRV3RDTEVkQlFVY3NUMEZCVHl4RFFVRkRMSEZDUVVGRUxFTkJRV3hET3p0QlFVVkJMRWxCUVUwc1QwRkJUeXhIUVVGSExGRkJRVkVzUTBGQlF5eGhRVUZVTEVOQlFYVkNMRTlCUVhaQ0xFTkJRV2hDTzBGQlEwRXNTVUZCVFN4VlFVRlZMRWRCUVVjc1VVRkJVU3hEUVVGRExHTkJRVlFzUTBGQmQwSXNXVUZCZUVJc1EwRkJia0k3UVVGRFFTeEpRVUZOTEZGQlFWRXNSMEZCUnl4UlFVRlJMRU5CUVVNc1kwRkJWQ3hEUVVGM1FpeFZRVUY0UWl4RFFVRnFRanRCUVVOQkxFbEJRVTBzVFVGQlRTeEhRVUZITEZGQlFWRXNRMEZCUXl4alFVRlVMRU5CUVhkQ0xGRkJRWGhDTEVOQlFXWTdRVUZEUVN4SlFVRk5MRlZCUVZVc1IwRkJSeXhSUVVGUkxFTkJRVU1zWTBGQlZDeERRVUYzUWl4WlFVRjRRaXhEUVVGdVFqdEJRVU5CTEVsQlFVMHNUMEZCVHl4SFFVRkhMRkZCUVZFc1EwRkJReXhqUVVGVUxFTkJRWGRDTEZOQlFYaENMRU5CUVdoQ08wRkJRMEVzU1VGQlRTeFRRVUZUTEVkQlFVY3NVVUZCVVN4RFFVRkRMR05CUVZRc1EwRkJkMElzVjBGQmVFSXNRMEZCYkVJN1FVRkRRU3hKUVVGTkxGTkJRVk1zUjBGQlJ5eFJRVUZSTEVOQlFVTXNZMEZCVkN4RFFVRjNRaXhYUVVGNFFpeERRVUZzUWp0QlFVTkJMRWxCUVUwc1UwRkJVeXhIUVVGSExGRkJRVkVzUTBGQlF5eGpRVUZVTEVOQlFYZENMRmRCUVhoQ0xFTkJRV3hDTzBGQlEwRXNTVUZCVFN4VFFVRlRMRWRCUVVjc1VVRkJVU3hEUVVGRExHTkJRVlFzUTBGQmQwSXNWMEZCZUVJc1EwRkJiRUk3UVVGRFFTeEpRVUZOTEZWQlFWVXNSMEZCUnl4UlFVRlJMRU5CUVVNc1kwRkJWQ3hEUVVGM1FpeFpRVUY0UWl4RFFVRnVRanRCUVVOQkxFbEJRVWtzVDBGQlR5eEhRVUZITEVOQlFXUTdRVUZEUVN4SlFVRkpMRTFCUVUwc1IwRkJSeXhEUVVGaU8wRkJRMEVzU1VGQlRTeFJRVUZSTEVkQlFVY3NRMEZEWmp0QlFVTkZMRVZCUVVFc1IwRkJSeXhGUVVGRkxHMUNRVVJRTzBGQlJVVXNSVUZCUVN4UlFVRlJMRVZCUVVVc2QwSkJSbG83UVVGSFJTeEZRVUZCTEVsQlFVa3NSVUZEUmp0QlFVcEtMRU5CUkdVc1JVRlBaanRCUVVORkxFVkJRVUVzUjBGQlJ5eEZRVUZGTEcxQ1FVUlFPMEZCUlVVc1JVRkJRU3hSUVVGUkxFVkJRVVVzYlVKQlJsbzdRVUZIUlN4RlFVRkJMRWxCUVVrc1JVRkRSanRCUVVwS0xFTkJVR1VzUlVGaFpqdEJRVU5GTEVWQlFVRXNSMEZCUnl4RlFVRkZMSEZDUVVSUU8wRkJSVVVzUlVGQlFTeFJRVUZSTEVWQlFVVXNWVUZHV2p0QlFVZEZMRVZCUVVFc1NVRkJTU3hGUVVOR08wRkJTa29zUTBGaVpTeEZRVzFDWmp0QlFVTkZMRVZCUVVFc1IwRkJSeXhGUVVGRkxEQkNRVVJRTzBGQlJVVXNSVUZCUVN4UlFVRlJMRVZCUVVVc1pVRkdXanRCUVVkRkxFVkJRVUVzU1VGQlNTeEZRVU5HTzBGQlNrb3NRMEZ1UW1Vc1JVRjVRbVk3UVVGRFJTeEZRVUZCTEVkQlFVY3NSVUZCUlN4dlFrRkVVRHRCUVVWRkxFVkJRVUVzVVVGQlVTeEZRVUZGTEZOQlJsbzdRVUZIUlN4RlFVRkJMRWxCUVVrc1JVRkRSanRCUVVwS0xFTkJla0psTEVWQkswSm1PMEZCUTBVc1JVRkJRU3hIUVVGSExFVkJRVVVzYlVKQlJGQTdRVUZGUlN4RlFVRkJMRkZCUVZFc1JVRkJSU3hSUVVaYU8wRkJSMFVzUlVGQlFTeEpRVUZKTEVWQlEwWTdRVUZLU2l4RFFTOUNaU3hGUVhGRFpqdEJRVU5GTEVWQlFVRXNSMEZCUnl4RlFVRkZMSEZDUVVSUU8wRkJSVVVzUlVGQlFTeFJRVUZSTEVWQlFVVXNWVUZHV2p0QlFVZEZMRVZCUVVFc1NVRkJTU3hGUVVOR08wRkJTa29zUTBGeVEyVXNSVUV5UTJZN1FVRkRSU3hGUVVGQkxFZEJRVWNzUlVGQlJTeHJRMEZFVUR0QlFVVkZMRVZCUVVFc1VVRkJVU3hGUVVGRkxIVkNRVVphTzBGQlIwVXNSVUZCUVN4SlFVRkpMRVZCUTBZN1FVRktTaXhEUVRORFpTeEZRV2xFWmp0QlFVTkZMRVZCUVVFc1IwRkJSeXhGUVVGRkxEUkNRVVJRTzBGQlJVVXNSVUZCUVN4UlFVRlJMRVZCUVVVc2FVSkJSbG83UVVGSFJTeEZRVUZCTEVsQlFVa3NSVUZEUmp0QlFVcEtMRU5CYWtSbExFTkJRV3BDTzBGQmVVUkJMRkZCUVZFc1EwRkJReXhuUWtGQlZDeERRVUV3UWl4UlFVRXhRaXhGUVVGdlF5eFpRVUZOTzBGQlEzaERMRTFCUVVrc1RVRkJUU3hEUVVGRExGZEJRVkFzUjBGQmNVSXNUMEZCVHl4RFFVRkRMRmxCUVdwRExFVkJRU3RETzBGQlF6ZERMRWxCUVVFc1QwRkJUeXhEUVVGRExGTkJRVklzUTBGQmEwSXNUVUZCYkVJc1EwRkJlVUlzVDBGQmVrSTdRVUZEUkN4SFFVWkVMRTFCUlU4N1FVRkRUQ3hKUVVGQkxFOUJRVThzUTBGQlF5eFRRVUZTTEVOQlFXdENMRWRCUVd4Q0xFTkJRWE5DTEU5QlFYUkNPMEZCUTBRN1FVRkRSaXhEUVU1RU96dEJRVkZCTEUxQlFVMHNRMEZCUXl4UFFVRlFMRWRCUVdsQ0xGVkJRVUVzUTBGQlF5eEZRVUZKTzBGQlEzQkNMRVZCUVVFc1EwRkJReXhEUVVGRExHTkJRVVk3UVVGRFFTeEZRVUZCTEZWQlFWVXNRMEZCUXl4VFFVRllMRU5CUVhGQ0xFMUJRWEpDTEVOQlFUUkNMRTFCUVRWQ08wRkJRMFFzUTBGSVJEczdRVUZMUVN4UlFVRlJMRU5CUVVNc1QwRkJWQ3hIUVVGdFFpeFZRVUZCTEVOQlFVTXNSVUZCU1R0QlFVTjBRaXhGUVVGQkxFTkJRVU1zUTBGQlF5eGpRVUZHTzBGQlEwRXNSVUZCUVN4VlFVRlZMRU5CUVVNc1UwRkJXQ3hEUVVGeFFpeE5RVUZ5UWl4RFFVRTBRaXhOUVVFMVFqdEJRVU5FTEVOQlNFUTdPMEZCUzBFc1ZVRkJWU3hEUVVGRExFOUJRVmdzUjBGQmNVSXNXVUZCVFR0QlFVTjZRaXhGUVVGQkxGVkJRVlVzUTBGQlF5eFRRVUZZTEVOQlFYRkNMRTFCUVhKQ0xFTkJRVFJDTEUxQlFUVkNPMEZCUTBRc1EwRkdSRHM3UVVGSlFTeFRRVUZUTEVOQlFVTXNaMEpCUVZZc1EwRkJNa0lzVDBGQk0wSXNSVUZCYjBNc1ZVRkJReXhEUVVGRUxFVkJRVTg3UVVGRGVrTXNUVUZCU1N4TlFVRk5MRWRCUVVjc1EwRkJReXhEUVVGRExFMUJRV1k3UVVGRFFTeE5RVUZOTEVsQlFVa3NSMEZCUnl4UlFVRlJMRU5CUVVNc2MwSkJRVlFzUTBGQlowTXNkMEpCUVdoRExFTkJRV0k3TzBGQlEwRXNUVUZCU1N4SFFVRkhMSE5DUVVGUExFbEJRVkFzUTBGQlVEczdRVUZEUVN4RlFVRkJMRWRCUVVjc1EwRkJReXhIUVVGS0xFTkJRVkVzVlVGQlFTeERRVUZETzBGQlFVRXNWMEZCU1N4RFFVRkRMRU5CUVVNc1UwRkJSaXhEUVVGWkxFMUJRVm9zUTBGQmJVSXNUVUZCYmtJc1EwRkJTanRCUVVGQkxFZEJRVlE3UVVGRFFTeEZRVUZCTEUxQlFVMHNRMEZCUXl4VFFVRlFMRU5CUVdsQ0xFZEJRV3BDTEVOQlFYRkNMRTFCUVhKQ08wRkJRMFFzUTBGT1JEczdRVUZSUVN4VFFVRlRMRU5CUVVNc1QwRkJWaXhIUVVGdlFpeFZRVUZCTEVOQlFVTXNSVUZCU1R0QlFVTjJRaXhGUVVGQkxFTkJRVU1zUTBGQlF5eGpRVUZHTzBGQlEwRXNSVUZCUVN4VFFVRlRMRU5CUVVNc1UwRkJWaXhEUVVGdlFpeEhRVUZ3UWl4RFFVRjNRaXhOUVVGNFFqdEJRVU5CTEVWQlFVRXNVMEZCVXl4RFFVRkRMRk5CUVZZc1EwRkJiMElzUjBGQmNFSXNRMEZCZDBJc1RVRkJlRUk3UVVGRFJDeERRVXBFT3p0QlFVMUJMRk5CUVZNc1EwRkJReXhQUVVGV0xFZEJRVzlDTEZWQlFVRXNRMEZCUXl4RlFVRkpPMEZCUTNaQ0xFVkJRVUVzUTBGQlF5eERRVUZETEdOQlFVWTdRVUZEUVN4RlFVRkJMRlZCUVZVc1EwRkJReXhUUVVGWUxFTkJRWEZDTEVkQlFYSkNMRU5CUVhsQ0xFMUJRWHBDTzBGQlEwUXNRMEZJUkRzN1FVRkxRU3hKUVVGTkxHTkJRV01zUjBGQlJ5eFRRVUZxUWl4alFVRnBRaXhEUVVGQkxFbEJRVWtzUlVGQlNUdEJRVU0zUWl3NFIwRkZZeXhKUVVGSkxFTkJRVU1zUjBGR2JrSXNNRWRCU1hGRExFbEJRVWtzUTBGQlF5eFJRVW94UXl4elJFRkxaME1zU1VGQlNTeERRVUZETEVsQlRISkRPMEZCVTBRc1EwRldSRHM3UVVGWlFTeEpRVUZKTEdGQlFXRXNSMEZCUnl4VFFVRm9RaXhoUVVGblFpeERRVUZCTEZsQlFWa3NSVUZCU1R0QlFVTnNReXhOUVVGTkxGRkJRVkVzUjBGQlJ5eFpRVUZaTEVOQlFVTXNSMEZCWWl4RFFVRnBRaXhWUVVGQkxFOUJRVTg3UVVGQlFTeFhRVUZKTEdOQlFXTXNRMEZCUXl4UFFVRkVMRU5CUVd4Q08wRkJRVUVzUjBGQmVFSXNRMEZCYWtJN1FVRkRRU3hGUVVGQkxGRkJRVkVzUTBGQlF5eGpRVUZVTEVOQlFYZENMR2RDUVVGNFFpeEZRVUV3UXl4VFFVRXhReXhIUVVGelJDeFJRVUZSTEVOQlFVTXNTVUZCVkN4RFFVRmpMRVZCUVdRc1EwRkJkRVE3UVVGRFJDeERRVWhFT3p0QlFVdEJMRTlCUVU4c1EwRkJReXhQUVVGU0xFZEJRV3RDTEZWQlFVRXNRMEZCUXl4RlFVRkpPMEZCUTNKQ0xFVkJRVUVzUTBGQlF5eERRVUZETEdOQlFVWTdRVUZEUVN4RlFVRkJMRTlCUVU4c1NVRkJTU3hOUVVGWU8wRkJRMEVzUlVGQlFTeGhRVUZoTEVOQlFVTXNVVUZCVVN4RFFVRkRMRXRCUVZRc1EwRkJaU3hEUVVGbUxFVkJRV3RDTEU5QlFXeENMRU5CUVVRc1EwRkJZanRCUVVORUxFTkJTa1E3TzBGQlRVRXNUVUZCVFN4RFFVRkRMR2RDUVVGUUxFTkJRWGRDTEd0Q1FVRjRRaXhGUVVFMFF5eFpRVUZOTzBGQlEyaEVMRTFCUVUwc1dVRkJXU3hIUVVGSExGTkJRV1lzV1VGQlpUdEJRVUZCTzBGQlFVRTdRVUZCUVR0QlFVRkJPMEZCUVVFc01FSkJRMWdzU1VGRVZ6dEJRVUZCTERSRFFVVmFMRkZCUVZFc1EwRkJReXhsUVVGVUxFTkJRWGxDTEZkQlFYcENMRWRCUVhWRExFZEJSak5DTEhWQ1FVdGFMRkZCUVZFc1EwRkJReXhsUVVGVUxFTkJRWGxDTEZkQlFYcENMRWRCUVhWRExFZEJURE5DTzBGQlFVRTdPMEZCUVVFN1FVRkhaaXhaUVVGQkxFOUJRVThzUjBGQlJ5eERRVUZXTzBGQlNHVTdPMEZCUVVFN1FVRk5aaXhaUVVGQkxFOUJRVThzUjBGQlJ5eERRVUZXTzBGQlEwRXNXVUZCUVN4TlFVRk5MRWRCUVVjc1EwRkJWRHRCUVZCbE96dEJRVUZCTzBGQlZXWXNXVUZCUVN4UFFVRlBMRWRCUVVjc1EwRkJWanRCUVVOQkxGbEJRVUVzVFVGQlRTeEhRVUZITEVOQlFWUTdRVUZZWlRzN1FVRkJRVHRCUVVGQk8wRkJRVUU3UVVGQlFUdEJRVUZCTzBGQlFVRTdRVUZCUVN4SFFVRnlRanM3UVVGbFFTeEZRVUZCTEZsQlFWazdRVUZEV2l4RlFVRkJMR0ZCUVdFc1EwRkJReXhSUVVGUkxFTkJRVU1zUzBGQlZDeERRVUZsTEVOQlFXWXNSVUZCYTBJc1QwRkJiRUlzUTBGQlJDeERRVUZpTzBGQlEwUXNRMEZzUWtRaUxDSm1hV3hsSWpvaVoyVnVaWEpoZEdWa0xtcHpJaXdpYzI5MWNtTmxVbTl2ZENJNklpSXNJbk52ZFhKalpYTkRiMjUwWlc1MElqcGJJaWhtZFc1amRHbHZiaWdwZTJaMWJtTjBhVzl1SUhJb1pTeHVMSFFwZTJaMWJtTjBhVzl1SUc4b2FTeG1LWHRwWmlnaGJsdHBYU2w3YVdZb0lXVmJhVjBwZTNaaGNpQmpQVndpWm5WdVkzUnBiMjVjSWowOWRIbHdaVzltSUhKbGNYVnBjbVVtSm5KbGNYVnBjbVU3YVdZb0lXWW1KbU1wY21WMGRYSnVJR01vYVN3aE1DazdhV1lvZFNseVpYUjFjbTRnZFNocExDRXdLVHQyWVhJZ1lUMXVaWGNnUlhKeWIzSW9YQ0pEWVc1dWIzUWdabWx1WkNCdGIyUjFiR1VnSjF3aUsya3JYQ0luWENJcE8zUm9jbTkzSUdFdVkyOWtaVDFjSWsxUFJGVk1SVjlPVDFSZlJrOVZUa1JjSWl4aGZYWmhjaUJ3UFc1YmFWMDllMlY0Y0c5eWRITTZlMzE5TzJWYmFWMWJNRjB1WTJGc2JDaHdMbVY0Y0c5eWRITXNablZ1WTNScGIyNG9jaWw3ZG1GeUlHNDlaVnRwWFZzeFhWdHlYVHR5WlhSMWNtNGdieWh1Zkh4eUtYMHNjQ3h3TG1WNGNHOXlkSE1zY2l4bExHNHNkQ2w5Y21WMGRYSnVJRzViYVYwdVpYaHdiM0owYzMxbWIzSW9kbUZ5SUhVOVhDSm1kVzVqZEdsdmJsd2lQVDEwZVhCbGIyWWdjbVZ4ZFdseVpTWW1jbVZ4ZFdseVpTeHBQVEE3YVR4MExteGxibWQwYUR0cEt5c3BieWgwVzJsZEtUdHlaWFIxY200Z2IzMXlaWFIxY200Z2NuMHBLQ2tpTENJdktpcGNiaUFxSUVOdmNIbHlhV2RvZENBb1l5a2dNakF4TkMxd2NtVnpaVzUwTENCR1lXTmxZbTl2YXl3Z1NXNWpMbHh1SUNwY2JpQXFJRlJvYVhNZ2MyOTFjbU5sSUdOdlpHVWdhWE1nYkdsalpXNXpaV1FnZFc1a1pYSWdkR2hsSUUxSlZDQnNhV05sYm5ObElHWnZkVzVrSUdsdUlIUm9aVnh1SUNvZ1RFbERSVTVUUlNCbWFXeGxJR2x1SUhSb1pTQnliMjkwSUdScGNtVmpkRzl5ZVNCdlppQjBhR2x6SUhOdmRYSmpaU0IwY21WbExseHVJQ292WEc1Y2JuWmhjaUJ5ZFc1MGFXMWxJRDBnS0daMWJtTjBhVzl1SUNobGVIQnZjblJ6S1NCN1hHNGdJRndpZFhObElITjBjbWxqZEZ3aU8xeHVYRzRnSUhaaGNpQlBjQ0E5SUU5aWFtVmpkQzV3Y205MGIzUjVjR1U3WEc0Z0lIWmhjaUJvWVhOUGQyNGdQU0JQY0M1b1lYTlBkMjVRY205d1pYSjBlVHRjYmlBZ2RtRnlJSFZ1WkdWbWFXNWxaRHNnTHk4Z1RXOXlaU0JqYjIxd2NtVnpjMmxpYkdVZ2RHaGhiaUIyYjJsa0lEQXVYRzRnSUhaaGNpQWtVM2x0WW05c0lEMGdkSGx3Wlc5bUlGTjViV0p2YkNBOVBUMGdYQ0ptZFc1amRHbHZibHdpSUQ4Z1UzbHRZbTlzSURvZ2UzMDdYRzRnSUhaaGNpQnBkR1Z5WVhSdmNsTjViV0p2YkNBOUlDUlRlVzFpYjJ3dWFYUmxjbUYwYjNJZ2ZId2dYQ0pBUUdsMFpYSmhkRzl5WENJN1hHNGdJSFpoY2lCaGMzbHVZMGwwWlhKaGRHOXlVM2x0WW05c0lEMGdKRk41YldKdmJDNWhjM2x1WTBsMFpYSmhkRzl5SUh4OElGd2lRRUJoYzNsdVkwbDBaWEpoZEc5eVhDSTdYRzRnSUhaaGNpQjBiMU4wY21sdVoxUmhaMU41YldKdmJDQTlJQ1JUZVcxaWIyd3VkRzlUZEhKcGJtZFVZV2NnZkh3Z1hDSkFRSFJ2VTNSeWFXNW5WR0ZuWENJN1hHNWNiaUFnWm5WdVkzUnBiMjRnZDNKaGNDaHBibTVsY2tadUxDQnZkWFJsY2tadUxDQnpaV3htTENCMGNubE1iMk56VEdsemRDa2dlMXh1SUNBZ0lDOHZJRWxtSUc5MWRHVnlSbTRnY0hKdmRtbGtaV1FnWVc1a0lHOTFkR1Z5Um00dWNISnZkRzkwZVhCbElHbHpJR0VnUjJWdVpYSmhkRzl5TENCMGFHVnVJRzkxZEdWeVJtNHVjSEp2ZEc5MGVYQmxJR2x1YzNSaGJtTmxiMllnUjJWdVpYSmhkRzl5TGx4dUlDQWdJSFpoY2lCd2NtOTBiMGRsYm1WeVlYUnZjaUE5SUc5MWRHVnlSbTRnSmlZZ2IzVjBaWEpHYmk1d2NtOTBiM1I1Y0dVZ2FXNXpkR0Z1WTJWdlppQkhaVzVsY21GMGIzSWdQeUJ2ZFhSbGNrWnVJRG9nUjJWdVpYSmhkRzl5TzF4dUlDQWdJSFpoY2lCblpXNWxjbUYwYjNJZ1BTQlBZbXBsWTNRdVkzSmxZWFJsS0hCeWIzUnZSMlZ1WlhKaGRHOXlMbkJ5YjNSdmRIbHdaU2s3WEc0Z0lDQWdkbUZ5SUdOdmJuUmxlSFFnUFNCdVpYY2dRMjl1ZEdWNGRDaDBjbmxNYjJOelRHbHpkQ0I4ZkNCYlhTazdYRzVjYmlBZ0lDQXZMeUJVYUdVZ0xsOXBiblp2YTJVZ2JXVjBhRzlrSUhWdWFXWnBaWE1nZEdobElHbHRjR3hsYldWdWRHRjBhVzl1Y3lCdlppQjBhR1VnTG01bGVIUXNYRzRnSUNBZ0x5OGdMblJvY205M0xDQmhibVFnTG5KbGRIVnliaUJ0WlhSb2IyUnpMbHh1SUNBZ0lHZGxibVZ5WVhSdmNpNWZhVzUyYjJ0bElEMGdiV0ZyWlVsdWRtOXJaVTFsZEdodlpDaHBibTVsY2tadUxDQnpaV3htTENCamIyNTBaWGgwS1R0Y2JseHVJQ0FnSUhKbGRIVnliaUJuWlc1bGNtRjBiM0k3WEc0Z0lIMWNiaUFnWlhod2IzSjBjeTUzY21Gd0lEMGdkM0poY0R0Y2JseHVJQ0F2THlCVWNua3ZZMkYwWTJnZ2FHVnNjR1Z5SUhSdklHMXBibWx0YVhwbElHUmxiM0IwYVcxcGVtRjBhVzl1Y3k0Z1VtVjBkWEp1Y3lCaElHTnZiWEJzWlhScGIyNWNiaUFnTHk4Z2NtVmpiM0prSUd4cGEyVWdZMjl1ZEdWNGRDNTBjbmxGYm5SeWFXVnpXMmxkTG1OdmJYQnNaWFJwYjI0dUlGUm9hWE1nYVc1MFpYSm1ZV05sSUdOdmRXeGtYRzRnSUM4dklHaGhkbVVnWW1WbGJpQW9ZVzVrSUhkaGN5QndjbVYyYVc5MWMyeDVLU0JrWlhOcFoyNWxaQ0IwYnlCMFlXdGxJR0VnWTJ4dmMzVnlaU0IwYnlCaVpWeHVJQ0F2THlCcGJuWnZhMlZrSUhkcGRHaHZkWFFnWVhKbmRXMWxiblJ6TENCaWRYUWdhVzRnWVd4c0lIUm9aU0JqWVhObGN5QjNaU0JqWVhKbElHRmliM1YwSUhkbFhHNGdJQzh2SUdGc2NtVmhaSGtnYUdGMlpTQmhiaUJsZUdsemRHbHVaeUJ0WlhSb2IyUWdkMlVnZDJGdWRDQjBieUJqWVd4c0xDQnpieUIwYUdWeVpTZHpJRzV2SUc1bFpXUmNiaUFnTHk4Z2RHOGdZM0psWVhSbElHRWdibVYzSUdaMWJtTjBhVzl1SUc5aWFtVmpkQzRnVjJVZ1kyRnVJR1YyWlc0Z1oyVjBJR0YzWVhrZ2QybDBhQ0JoYzNOMWJXbHVaMXh1SUNBdkx5QjBhR1VnYldWMGFHOWtJSFJoYTJWeklHVjRZV04wYkhrZ2IyNWxJR0Z5WjNWdFpXNTBMQ0J6YVc1alpTQjBhR0YwSUdoaGNIQmxibk1nZEc4Z1ltVWdkSEoxWlZ4dUlDQXZMeUJwYmlCbGRtVnllU0JqWVhObExDQnpieUIzWlNCa2IyNG5kQ0JvWVhabElIUnZJSFJ2ZFdOb0lIUm9aU0JoY21kMWJXVnVkSE1nYjJKcVpXTjBMaUJVYUdWY2JpQWdMeThnYjI1c2VTQmhaR1JwZEdsdmJtRnNJR0ZzYkc5allYUnBiMjRnY21WeGRXbHlaV1FnYVhNZ2RHaGxJR052YlhCc1pYUnBiMjRnY21WamIzSmtMQ0IzYUdsamFGeHVJQ0F2THlCb1lYTWdZU0J6ZEdGaWJHVWdjMmhoY0dVZ1lXNWtJSE52SUdodmNHVm1kV3hzZVNCemFHOTFiR1FnWW1VZ1kyaGxZWEFnZEc4Z1lXeHNiMk5oZEdVdVhHNGdJR1oxYm1OMGFXOXVJSFJ5ZVVOaGRHTm9LR1p1TENCdlltb3NJR0Z5WnlrZ2UxeHVJQ0FnSUhSeWVTQjdYRzRnSUNBZ0lDQnlaWFIxY200Z2V5QjBlWEJsT2lCY0ltNXZjbTFoYkZ3aUxDQmhjbWM2SUdadUxtTmhiR3dvYjJKcUxDQmhjbWNwSUgwN1hHNGdJQ0FnZlNCallYUmphQ0FvWlhKeUtTQjdYRzRnSUNBZ0lDQnlaWFIxY200Z2V5QjBlWEJsT2lCY0luUm9jbTkzWENJc0lHRnlaem9nWlhKeUlIMDdYRzRnSUNBZ2ZWeHVJQ0I5WEc1Y2JpQWdkbUZ5SUVkbGJsTjBZWFJsVTNWemNHVnVaR1ZrVTNSaGNuUWdQU0JjSW5OMWMzQmxibVJsWkZOMFlYSjBYQ0k3WEc0Z0lIWmhjaUJIWlc1VGRHRjBaVk4xYzNCbGJtUmxaRmxwWld4a0lEMGdYQ0p6ZFhOd1pXNWtaV1JaYVdWc1pGd2lPMXh1SUNCMllYSWdSMlZ1VTNSaGRHVkZlR1ZqZFhScGJtY2dQU0JjSW1WNFpXTjFkR2x1WjF3aU8xeHVJQ0IyWVhJZ1IyVnVVM1JoZEdWRGIyMXdiR1YwWldRZ1BTQmNJbU52YlhCc1pYUmxaRndpTzF4dVhHNGdJQzh2SUZKbGRIVnlibWx1WnlCMGFHbHpJRzlpYW1WamRDQm1jbTl0SUhSb1pTQnBibTVsY2tadUlHaGhjeUIwYUdVZ2MyRnRaU0JsWm1abFkzUWdZWE5jYmlBZ0x5OGdZbkpsWVd0cGJtY2diM1YwSUc5bUlIUm9aU0JrYVhOd1lYUmphQ0J6ZDJsMFkyZ2djM1JoZEdWdFpXNTBMbHh1SUNCMllYSWdRMjl1ZEdsdWRXVlRaVzUwYVc1bGJDQTlJSHQ5TzF4dVhHNGdJQzh2SUVSMWJXMTVJR052Ym5OMGNuVmpkRzl5SUdaMWJtTjBhVzl1Y3lCMGFHRjBJSGRsSUhWelpTQmhjeUIwYUdVZ0xtTnZibk4wY25WamRHOXlJR0Z1WkZ4dUlDQXZMeUF1WTI5dWMzUnlkV04wYjNJdWNISnZkRzkwZVhCbElIQnliM0JsY25ScFpYTWdabTl5SUdaMWJtTjBhVzl1Y3lCMGFHRjBJSEpsZEhWeWJpQkhaVzVsY21GMGIzSmNiaUFnTHk4Z2IySnFaV04wY3k0Z1JtOXlJR1oxYkd3Z2MzQmxZeUJqYjIxd2JHbGhibU5sTENCNWIzVWdiV0Y1SUhkcGMyZ2dkRzhnWTI5dVptbG5kWEpsSUhsdmRYSmNiaUFnTHk4Z2JXbHVhV1pwWlhJZ2JtOTBJSFJ2SUcxaGJtZHNaU0IwYUdVZ2JtRnRaWE1nYjJZZ2RHaGxjMlVnZEhkdklHWjFibU4wYVc5dWN5NWNiaUFnWm5WdVkzUnBiMjRnUjJWdVpYSmhkRzl5S0NrZ2UzMWNiaUFnWm5WdVkzUnBiMjRnUjJWdVpYSmhkRzl5Um5WdVkzUnBiMjRvS1NCN2ZWeHVJQ0JtZFc1amRHbHZiaUJIWlc1bGNtRjBiM0pHZFc1amRHbHZibEJ5YjNSdmRIbHdaU2dwSUh0OVhHNWNiaUFnTHk4Z1ZHaHBjeUJwY3lCaElIQnZiSGxtYVd4c0lHWnZjaUFsU1hSbGNtRjBiM0pRY205MGIzUjVjR1VsSUdadmNpQmxiblpwY205dWJXVnVkSE1nZEdoaGRGeHVJQ0F2THlCa2IyNG5kQ0J1WVhScGRtVnNlU0J6ZFhCd2IzSjBJR2wwTGx4dUlDQjJZWElnU1hSbGNtRjBiM0pRY205MGIzUjVjR1VnUFNCN2ZUdGNiaUFnU1hSbGNtRjBiM0pRY205MGIzUjVjR1ZiYVhSbGNtRjBiM0pUZVcxaWIyeGRJRDBnWm5WdVkzUnBiMjRnS0NrZ2UxeHVJQ0FnSUhKbGRIVnliaUIwYUdsek8xeHVJQ0I5TzF4dVhHNGdJSFpoY2lCblpYUlFjbTkwYnlBOUlFOWlhbVZqZEM1blpYUlFjbTkwYjNSNWNHVlBaanRjYmlBZ2RtRnlJRTVoZEdsMlpVbDBaWEpoZEc5eVVISnZkRzkwZVhCbElEMGdaMlYwVUhKdmRHOGdKaVlnWjJWMFVISnZkRzhvWjJWMFVISnZkRzhvZG1Gc2RXVnpLRnRkS1NrcE8xeHVJQ0JwWmlBb1RtRjBhWFpsU1hSbGNtRjBiM0pRY205MGIzUjVjR1VnSmlaY2JpQWdJQ0FnSUU1aGRHbDJaVWwwWlhKaGRHOXlVSEp2ZEc5MGVYQmxJQ0U5UFNCUGNDQW1KbHh1SUNBZ0lDQWdhR0Z6VDNkdUxtTmhiR3dvVG1GMGFYWmxTWFJsY21GMGIzSlFjbTkwYjNSNWNHVXNJR2wwWlhKaGRHOXlVM2x0WW05c0tTa2dlMXh1SUNBZ0lDOHZJRlJvYVhNZ1pXNTJhWEp2Ym0xbGJuUWdhR0Z6SUdFZ2JtRjBhWFpsSUNWSmRHVnlZWFJ2Y2xCeWIzUnZkSGx3WlNVN0lIVnpaU0JwZENCcGJuTjBaV0ZrWEc0Z0lDQWdMeThnYjJZZ2RHaGxJSEJ2YkhsbWFXeHNMbHh1SUNBZ0lFbDBaWEpoZEc5eVVISnZkRzkwZVhCbElEMGdUbUYwYVhabFNYUmxjbUYwYjNKUWNtOTBiM1I1Y0dVN1hHNGdJSDFjYmx4dUlDQjJZWElnUjNBZ1BTQkhaVzVsY21GMGIzSkdkVzVqZEdsdmJsQnliM1J2ZEhsd1pTNXdjbTkwYjNSNWNHVWdQVnh1SUNBZ0lFZGxibVZ5WVhSdmNpNXdjbTkwYjNSNWNHVWdQU0JQWW1wbFkzUXVZM0psWVhSbEtFbDBaWEpoZEc5eVVISnZkRzkwZVhCbEtUdGNiaUFnUjJWdVpYSmhkRzl5Um5WdVkzUnBiMjR1Y0hKdmRHOTBlWEJsSUQwZ1IzQXVZMjl1YzNSeWRXTjBiM0lnUFNCSFpXNWxjbUYwYjNKR2RXNWpkR2x2YmxCeWIzUnZkSGx3WlR0Y2JpQWdSMlZ1WlhKaGRHOXlSblZ1WTNScGIyNVFjbTkwYjNSNWNHVXVZMjl1YzNSeWRXTjBiM0lnUFNCSFpXNWxjbUYwYjNKR2RXNWpkR2x2Ymp0Y2JpQWdSMlZ1WlhKaGRHOXlSblZ1WTNScGIyNVFjbTkwYjNSNWNHVmJkRzlUZEhKcGJtZFVZV2RUZVcxaWIyeGRJRDFjYmlBZ0lDQkhaVzVsY21GMGIzSkdkVzVqZEdsdmJpNWthWE53YkdGNVRtRnRaU0E5SUZ3aVIyVnVaWEpoZEc5eVJuVnVZM1JwYjI1Y0lqdGNibHh1SUNBdkx5QklaV3h3WlhJZ1ptOXlJR1JsWm1sdWFXNW5JSFJvWlNBdWJtVjRkQ3dnTG5Sb2NtOTNMQ0JoYm1RZ0xuSmxkSFZ5YmlCdFpYUm9iMlJ6SUc5bUlIUm9aVnh1SUNBdkx5QkpkR1Z5WVhSdmNpQnBiblJsY21aaFkyVWdhVzRnZEdWeWJYTWdiMllnWVNCemFXNW5iR1VnTGw5cGJuWnZhMlVnYldWMGFHOWtMbHh1SUNCbWRXNWpkR2x2YmlCa1pXWnBibVZKZEdWeVlYUnZjazFsZEdodlpITW9jSEp2ZEc5MGVYQmxLU0I3WEc0Z0lDQWdXMXdpYm1WNGRGd2lMQ0JjSW5Sb2NtOTNYQ0lzSUZ3aWNtVjBkWEp1WENKZExtWnZja1ZoWTJnb1puVnVZM1JwYjI0b2JXVjBhRzlrS1NCN1hHNGdJQ0FnSUNCd2NtOTBiM1I1Y0dWYmJXVjBhRzlrWFNBOUlHWjFibU4wYVc5dUtHRnlaeWtnZTF4dUlDQWdJQ0FnSUNCeVpYUjFjbTRnZEdocGN5NWZhVzUyYjJ0bEtHMWxkR2h2WkN3Z1lYSm5LVHRjYmlBZ0lDQWdJSDA3WEc0Z0lDQWdmU2s3WEc0Z0lIMWNibHh1SUNCbGVIQnZjblJ6TG1selIyVnVaWEpoZEc5eVJuVnVZM1JwYjI0Z1BTQm1kVzVqZEdsdmJpaG5aVzVHZFc0cElIdGNiaUFnSUNCMllYSWdZM1J2Y2lBOUlIUjVjR1Z2WmlCblpXNUdkVzRnUFQwOUlGd2lablZ1WTNScGIyNWNJaUFtSmlCblpXNUdkVzR1WTI5dWMzUnlkV04wYjNJN1hHNGdJQ0FnY21WMGRYSnVJR04wYjNKY2JpQWdJQ0FnSUQ4Z1kzUnZjaUE5UFQwZ1IyVnVaWEpoZEc5eVJuVnVZM1JwYjI0Z2ZIeGNiaUFnSUNBZ0lDQWdMeThnUm05eUlIUm9aU0J1WVhScGRtVWdSMlZ1WlhKaGRHOXlSblZ1WTNScGIyNGdZMjl1YzNSeWRXTjBiM0lzSUhSb1pTQmlaWE4wSUhkbElHTmhibHh1SUNBZ0lDQWdJQ0F2THlCa2J5QnBjeUIwYnlCamFHVmpheUJwZEhNZ0xtNWhiV1VnY0hKdmNHVnlkSGt1WEc0Z0lDQWdJQ0FnSUNoamRHOXlMbVJwYzNCc1lYbE9ZVzFsSUh4OElHTjBiM0l1Ym1GdFpTa2dQVDA5SUZ3aVIyVnVaWEpoZEc5eVJuVnVZM1JwYjI1Y0lseHVJQ0FnSUNBZ09pQm1ZV3h6WlR0Y2JpQWdmVHRjYmx4dUlDQmxlSEJ2Y25SekxtMWhjbXNnUFNCbWRXNWpkR2x2YmloblpXNUdkVzRwSUh0Y2JpQWdJQ0JwWmlBb1QySnFaV04wTG5ObGRGQnliM1J2ZEhsd1pVOW1LU0I3WEc0Z0lDQWdJQ0JQWW1wbFkzUXVjMlYwVUhKdmRHOTBlWEJsVDJZb1oyVnVSblZ1TENCSFpXNWxjbUYwYjNKR2RXNWpkR2x2YmxCeWIzUnZkSGx3WlNrN1hHNGdJQ0FnZlNCbGJITmxJSHRjYmlBZ0lDQWdJR2RsYmtaMWJpNWZYM0J5YjNSdlgxOGdQU0JIWlc1bGNtRjBiM0pHZFc1amRHbHZibEJ5YjNSdmRIbHdaVHRjYmlBZ0lDQWdJR2xtSUNnaEtIUnZVM1J5YVc1blZHRm5VM2x0WW05c0lHbHVJR2RsYmtaMWJpa3BJSHRjYmlBZ0lDQWdJQ0FnWjJWdVJuVnVXM1J2VTNSeWFXNW5WR0ZuVTNsdFltOXNYU0E5SUZ3aVIyVnVaWEpoZEc5eVJuVnVZM1JwYjI1Y0lqdGNiaUFnSUNBZ0lIMWNiaUFnSUNCOVhHNGdJQ0FnWjJWdVJuVnVMbkJ5YjNSdmRIbHdaU0E5SUU5aWFtVmpkQzVqY21WaGRHVW9SM0FwTzF4dUlDQWdJSEpsZEhWeWJpQm5aVzVHZFc0N1hHNGdJSDA3WEc1Y2JpQWdMeThnVjJsMGFHbHVJSFJvWlNCaWIyUjVJRzltSUdGdWVTQmhjM2x1WXlCbWRXNWpkR2x2Yml3Z1lHRjNZV2wwSUhoZ0lHbHpJSFJ5WVc1elptOXliV1ZrSUhSdlhHNGdJQzh2SUdCNWFXVnNaQ0J5WldkbGJtVnlZWFJ2Y2xKMWJuUnBiV1V1WVhkeVlYQW9lQ2xnTENCemJ5QjBhR0YwSUhSb1pTQnlkVzUwYVcxbElHTmhiaUIwWlhOMFhHNGdJQzh2SUdCb1lYTlBkMjR1WTJGc2JDaDJZV3gxWlN3Z1hDSmZYMkYzWVdsMFhDSXBZQ0IwYnlCa1pYUmxjbTFwYm1VZ2FXWWdkR2hsSUhscFpXeGtaV1FnZG1Gc2RXVWdhWE5jYmlBZ0x5OGdiV1ZoYm5RZ2RHOGdZbVVnWVhkaGFYUmxaQzVjYmlBZ1pYaHdiM0owY3k1aGQzSmhjQ0E5SUdaMWJtTjBhVzl1S0dGeVp5a2dlMXh1SUNBZ0lISmxkSFZ5YmlCN0lGOWZZWGRoYVhRNklHRnlaeUI5TzF4dUlDQjlPMXh1WEc0Z0lHWjFibU4wYVc5dUlFRnplVzVqU1hSbGNtRjBiM0lvWjJWdVpYSmhkRzl5S1NCN1hHNGdJQ0FnWm5WdVkzUnBiMjRnYVc1MmIydGxLRzFsZEdodlpDd2dZWEpuTENCeVpYTnZiSFpsTENCeVpXcGxZM1FwSUh0Y2JpQWdJQ0FnSUhaaGNpQnlaV052Y21RZ1BTQjBjbmxEWVhSamFDaG5aVzVsY21GMGIzSmJiV1YwYUc5a1hTd2daMlZ1WlhKaGRHOXlMQ0JoY21jcE8xeHVJQ0FnSUNBZ2FXWWdLSEpsWTI5eVpDNTBlWEJsSUQwOVBTQmNJblJvY205M1hDSXBJSHRjYmlBZ0lDQWdJQ0FnY21WcVpXTjBLSEpsWTI5eVpDNWhjbWNwTzF4dUlDQWdJQ0FnZlNCbGJITmxJSHRjYmlBZ0lDQWdJQ0FnZG1GeUlISmxjM1ZzZENBOUlISmxZMjl5WkM1aGNtYzdYRzRnSUNBZ0lDQWdJSFpoY2lCMllXeDFaU0E5SUhKbGMzVnNkQzUyWVd4MVpUdGNiaUFnSUNBZ0lDQWdhV1lnS0haaGJIVmxJQ1ltWEc0Z0lDQWdJQ0FnSUNBZ0lDQjBlWEJsYjJZZ2RtRnNkV1VnUFQwOUlGd2liMkpxWldOMFhDSWdKaVpjYmlBZ0lDQWdJQ0FnSUNBZ0lHaGhjMDkzYmk1allXeHNLSFpoYkhWbExDQmNJbDlmWVhkaGFYUmNJaWtwSUh0Y2JpQWdJQ0FnSUNBZ0lDQnlaWFIxY200Z1VISnZiV2x6WlM1eVpYTnZiSFpsS0haaGJIVmxMbDlmWVhkaGFYUXBMblJvWlc0b1puVnVZM1JwYjI0b2RtRnNkV1VwSUh0Y2JpQWdJQ0FnSUNBZ0lDQWdJR2x1ZG05clpTaGNJbTVsZUhSY0lpd2dkbUZzZFdVc0lISmxjMjlzZG1Vc0lISmxhbVZqZENrN1hHNGdJQ0FnSUNBZ0lDQWdmU3dnWm5WdVkzUnBiMjRvWlhKeUtTQjdYRzRnSUNBZ0lDQWdJQ0FnSUNCcGJuWnZhMlVvWENKMGFISnZkMXdpTENCbGNuSXNJSEpsYzI5c2RtVXNJSEpsYW1WamRDazdYRzRnSUNBZ0lDQWdJQ0FnZlNrN1hHNGdJQ0FnSUNBZ0lIMWNibHh1SUNBZ0lDQWdJQ0J5WlhSMWNtNGdVSEp2YldselpTNXlaWE52YkhabEtIWmhiSFZsS1M1MGFHVnVLR1oxYm1OMGFXOXVLSFZ1ZDNKaGNIQmxaQ2tnZTF4dUlDQWdJQ0FnSUNBZ0lDOHZJRmRvWlc0Z1lTQjVhV1ZzWkdWa0lGQnliMjFwYzJVZ2FYTWdjbVZ6YjJ4MlpXUXNJR2wwY3lCbWFXNWhiQ0IyWVd4MVpTQmlaV052YldWelhHNGdJQ0FnSUNBZ0lDQWdMeThnZEdobElDNTJZV3gxWlNCdlppQjBhR1VnVUhKdmJXbHpaVHg3ZG1Gc2RXVXNaRzl1WlgwK0lISmxjM1ZzZENCbWIzSWdkR2hsWEc0Z0lDQWdJQ0FnSUNBZ0x5OGdZM1Z5Y21WdWRDQnBkR1Z5WVhScGIyNHVYRzRnSUNBZ0lDQWdJQ0FnY21WemRXeDBMblpoYkhWbElEMGdkVzUzY21Gd2NHVmtPMXh1SUNBZ0lDQWdJQ0FnSUhKbGMyOXNkbVVvY21WemRXeDBLVHRjYmlBZ0lDQWdJQ0FnZlN3Z1puVnVZM1JwYjI0b1pYSnliM0lwSUh0Y2JpQWdJQ0FnSUNBZ0lDQXZMeUJKWmlCaElISmxhbVZqZEdWa0lGQnliMjFwYzJVZ2QyRnpJSGxwWld4a1pXUXNJSFJvY205M0lIUm9aU0J5WldwbFkzUnBiMjRnWW1GamExeHVJQ0FnSUNBZ0lDQWdJQzh2SUdsdWRHOGdkR2hsSUdGemVXNWpJR2RsYm1WeVlYUnZjaUJtZFc1amRHbHZiaUJ6YnlCcGRDQmpZVzRnWW1VZ2FHRnVaR3hsWkNCMGFHVnlaUzVjYmlBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnYVc1MmIydGxLRndpZEdoeWIzZGNJaXdnWlhKeWIzSXNJSEpsYzI5c2RtVXNJSEpsYW1WamRDazdYRzRnSUNBZ0lDQWdJSDBwTzF4dUlDQWdJQ0FnZlZ4dUlDQWdJSDFjYmx4dUlDQWdJSFpoY2lCd2NtVjJhVzkxYzFCeWIyMXBjMlU3WEc1Y2JpQWdJQ0JtZFc1amRHbHZiaUJsYm5GMVpYVmxLRzFsZEdodlpDd2dZWEpuS1NCN1hHNGdJQ0FnSUNCbWRXNWpkR2x2YmlCallXeHNTVzUyYjJ0bFYybDBhRTFsZEdodlpFRnVaRUZ5WnlncElIdGNiaUFnSUNBZ0lDQWdjbVYwZFhKdUlHNWxkeUJRY205dGFYTmxLR1oxYm1OMGFXOXVLSEpsYzI5c2RtVXNJSEpsYW1WamRDa2dlMXh1SUNBZ0lDQWdJQ0FnSUdsdWRtOXJaU2h0WlhSb2IyUXNJR0Z5Wnl3Z2NtVnpiMngyWlN3Z2NtVnFaV04wS1R0Y2JpQWdJQ0FnSUNBZ2ZTazdYRzRnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJSEpsZEhWeWJpQndjbVYyYVc5MWMxQnliMjFwYzJVZ1BWeHVJQ0FnSUNBZ0lDQXZMeUJKWmlCbGJuRjFaWFZsSUdoaGN5QmlaV1Z1SUdOaGJHeGxaQ0JpWldadmNtVXNJSFJvWlc0Z2QyVWdkMkZ1ZENCMGJ5QjNZV2wwSUhWdWRHbHNYRzRnSUNBZ0lDQWdJQzh2SUdGc2JDQndjbVYyYVc5MWN5QlFjbTl0YVhObGN5Qm9ZWFpsSUdKbFpXNGdjbVZ6YjJ4MlpXUWdZbVZtYjNKbElHTmhiR3hwYm1jZ2FXNTJiMnRsTEZ4dUlDQWdJQ0FnSUNBdkx5QnpieUIwYUdGMElISmxjM1ZzZEhNZ1lYSmxJR0ZzZDJGNWN5QmtaV3hwZG1WeVpXUWdhVzRnZEdobElHTnZjbkpsWTNRZ2IzSmtaWEl1SUVsbVhHNGdJQ0FnSUNBZ0lDOHZJR1Z1Y1hWbGRXVWdhR0Z6SUc1dmRDQmlaV1Z1SUdOaGJHeGxaQ0JpWldadmNtVXNJSFJvWlc0Z2FYUWdhWE1nYVcxd2IzSjBZVzUwSUhSdlhHNGdJQ0FnSUNBZ0lDOHZJR05oYkd3Z2FXNTJiMnRsSUdsdGJXVmthV0YwWld4NUxDQjNhWFJvYjNWMElIZGhhWFJwYm1jZ2IyNGdZU0JqWVd4c1ltRmpheUIwYnlCbWFYSmxMRnh1SUNBZ0lDQWdJQ0F2THlCemJ5QjBhR0YwSUhSb1pTQmhjM2x1WXlCblpXNWxjbUYwYjNJZ1puVnVZM1JwYjI0Z2FHRnpJSFJvWlNCdmNIQnZjblIxYm1sMGVTQjBieUJrYjF4dUlDQWdJQ0FnSUNBdkx5QmhibmtnYm1WalpYTnpZWEo1SUhObGRIVndJR2x1SUdFZ2NISmxaR2xqZEdGaWJHVWdkMkY1TGlCVWFHbHpJSEJ5WldScFkzUmhZbWxzYVhSNVhHNGdJQ0FnSUNBZ0lDOHZJR2x6SUhkb2VTQjBhR1VnVUhKdmJXbHpaU0JqYjI1emRISjFZM1J2Y2lCemVXNWphSEp2Ym05MWMyeDVJR2x1ZG05clpYTWdhWFJ6WEc0Z0lDQWdJQ0FnSUM4dklHVjRaV04xZEc5eUlHTmhiR3hpWVdOckxDQmhibVFnZDJoNUlHRnplVzVqSUdaMWJtTjBhVzl1Y3lCemVXNWphSEp2Ym05MWMyeDVYRzRnSUNBZ0lDQWdJQzh2SUdWNFpXTjFkR1VnWTI5a1pTQmlaV1p2Y21VZ2RHaGxJR1pwY25OMElHRjNZV2wwTGlCVGFXNWpaU0IzWlNCcGJYQnNaVzFsYm5RZ2MybHRjR3hsWEc0Z0lDQWdJQ0FnSUM4dklHRnplVzVqSUdaMWJtTjBhVzl1Y3lCcGJpQjBaWEp0Y3lCdlppQmhjM2x1WXlCblpXNWxjbUYwYjNKekxDQnBkQ0JwY3lCbGMzQmxZMmxoYkd4NVhHNGdJQ0FnSUNBZ0lDOHZJR2x0Y0c5eWRHRnVkQ0IwYnlCblpYUWdkR2hwY3lCeWFXZG9kQ3dnWlhabGJpQjBhRzkxWjJnZ2FYUWdjbVZ4ZFdseVpYTWdZMkZ5WlM1Y2JpQWdJQ0FnSUNBZ2NISmxkbWx2ZFhOUWNtOXRhWE5sSUQ4Z2NISmxkbWx2ZFhOUWNtOXRhWE5sTG5Sb1pXNG9YRzRnSUNBZ0lDQWdJQ0FnWTJGc2JFbHVkbTlyWlZkcGRHaE5aWFJvYjJSQmJtUkJjbWNzWEc0Z0lDQWdJQ0FnSUNBZ0x5OGdRWFp2YVdRZ2NISnZjR0ZuWVhScGJtY2dabUZwYkhWeVpYTWdkRzhnVUhKdmJXbHpaWE1nY21WMGRYSnVaV1FnWW5rZ2JHRjBaWEpjYmlBZ0lDQWdJQ0FnSUNBdkx5QnBiblp2WTJGMGFXOXVjeUJ2WmlCMGFHVWdhWFJsY21GMGIzSXVYRzRnSUNBZ0lDQWdJQ0FnWTJGc2JFbHVkbTlyWlZkcGRHaE5aWFJvYjJSQmJtUkJjbWRjYmlBZ0lDQWdJQ0FnS1NBNklHTmhiR3hKYm5admEyVlhhWFJvVFdWMGFHOWtRVzVrUVhKbktDazdYRzRnSUNBZ2ZWeHVYRzRnSUNBZ0x5OGdSR1ZtYVc1bElIUm9aU0IxYm1sbWFXVmtJR2hsYkhCbGNpQnRaWFJvYjJRZ2RHaGhkQ0JwY3lCMWMyVmtJSFJ2SUdsdGNHeGxiV1Z1ZENBdWJtVjRkQ3hjYmlBZ0lDQXZMeUF1ZEdoeWIzY3NJR0Z1WkNBdWNtVjBkWEp1SUNoelpXVWdaR1ZtYVc1bFNYUmxjbUYwYjNKTlpYUm9iMlJ6S1M1Y2JpQWdJQ0IwYUdsekxsOXBiblp2YTJVZ1BTQmxibkYxWlhWbE8xeHVJQ0I5WEc1Y2JpQWdaR1ZtYVc1bFNYUmxjbUYwYjNKTlpYUm9iMlJ6S0VGemVXNWpTWFJsY21GMGIzSXVjSEp2ZEc5MGVYQmxLVHRjYmlBZ1FYTjVibU5KZEdWeVlYUnZjaTV3Y205MGIzUjVjR1ZiWVhONWJtTkpkR1Z5WVhSdmNsTjViV0p2YkYwZ1BTQm1kVzVqZEdsdmJpQW9LU0I3WEc0Z0lDQWdjbVYwZFhKdUlIUm9hWE03WEc0Z0lIMDdYRzRnSUdWNGNHOXlkSE11UVhONWJtTkpkR1Z5WVhSdmNpQTlJRUZ6ZVc1alNYUmxjbUYwYjNJN1hHNWNiaUFnTHk4Z1RtOTBaU0IwYUdGMElITnBiWEJzWlNCaGMzbHVZeUJtZFc1amRHbHZibk1nWVhKbElHbHRjR3hsYldWdWRHVmtJRzl1SUhSdmNDQnZabHh1SUNBdkx5QkJjM2x1WTBsMFpYSmhkRzl5SUc5aWFtVmpkSE03SUhSb1pYa2dhblZ6ZENCeVpYUjFjbTRnWVNCUWNtOXRhWE5sSUdadmNpQjBhR1VnZG1Gc2RXVWdiMlpjYmlBZ0x5OGdkR2hsSUdacGJtRnNJSEpsYzNWc2RDQndjbTlrZFdObFpDQmllU0IwYUdVZ2FYUmxjbUYwYjNJdVhHNGdJR1Y0Y0c5eWRITXVZWE41Ym1NZ1BTQm1kVzVqZEdsdmJpaHBibTVsY2tadUxDQnZkWFJsY2tadUxDQnpaV3htTENCMGNubE1iMk56VEdsemRDa2dlMXh1SUNBZ0lIWmhjaUJwZEdWeUlEMGdibVYzSUVGemVXNWpTWFJsY21GMGIzSW9YRzRnSUNBZ0lDQjNjbUZ3S0dsdWJtVnlSbTRzSUc5MWRHVnlSbTRzSUhObGJHWXNJSFJ5ZVV4dlkzTk1hWE4wS1Z4dUlDQWdJQ2s3WEc1Y2JpQWdJQ0J5WlhSMWNtNGdaWGh3YjNKMGN5NXBjMGRsYm1WeVlYUnZja1oxYm1OMGFXOXVLRzkxZEdWeVJtNHBYRzRnSUNBZ0lDQS9JR2wwWlhJZ0x5OGdTV1lnYjNWMFpYSkdiaUJwY3lCaElHZGxibVZ5WVhSdmNpd2djbVYwZFhKdUlIUm9aU0JtZFd4c0lHbDBaWEpoZEc5eUxseHVJQ0FnSUNBZ09pQnBkR1Z5TG01bGVIUW9LUzUwYUdWdUtHWjFibU4wYVc5dUtISmxjM1ZzZENrZ2UxeHVJQ0FnSUNBZ0lDQWdJSEpsZEhWeWJpQnlaWE4xYkhRdVpHOXVaU0EvSUhKbGMzVnNkQzUyWVd4MVpTQTZJR2wwWlhJdWJtVjRkQ2dwTzF4dUlDQWdJQ0FnSUNCOUtUdGNiaUFnZlR0Y2JseHVJQ0JtZFc1amRHbHZiaUJ0WVd0bFNXNTJiMnRsVFdWMGFHOWtLR2x1Ym1WeVJtNHNJSE5sYkdZc0lHTnZiblJsZUhRcElIdGNiaUFnSUNCMllYSWdjM1JoZEdVZ1BTQkhaVzVUZEdGMFpWTjFjM0JsYm1SbFpGTjBZWEowTzF4dVhHNGdJQ0FnY21WMGRYSnVJR1oxYm1OMGFXOXVJR2x1ZG05clpTaHRaWFJvYjJRc0lHRnlaeWtnZTF4dUlDQWdJQ0FnYVdZZ0tITjBZWFJsSUQwOVBTQkhaVzVUZEdGMFpVVjRaV04xZEdsdVp5a2dlMXh1SUNBZ0lDQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9YQ0pIWlc1bGNtRjBiM0lnYVhNZ1lXeHlaV0ZrZVNCeWRXNXVhVzVuWENJcE8xeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQnBaaUFvYzNSaGRHVWdQVDA5SUVkbGJsTjBZWFJsUTI5dGNHeGxkR1ZrS1NCN1hHNGdJQ0FnSUNBZ0lHbG1JQ2h0WlhSb2IyUWdQVDA5SUZ3aWRHaHliM2RjSWlrZ2UxeHVJQ0FnSUNBZ0lDQWdJSFJvY205M0lHRnlaenRjYmlBZ0lDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNBZ0lDOHZJRUpsSUdadmNtZHBkbWx1Wnl3Z2NHVnlJREkxTGpNdU15NHpMak1nYjJZZ2RHaGxJSE53WldNNlhHNGdJQ0FnSUNBZ0lDOHZJR2gwZEhCek9pOHZjR1Z2Y0d4bExtMXZlbWxzYkdFdWIzSm5MMzVxYjNKbGJtUnZjbVptTDJWek5pMWtjbUZtZEM1b2RHMXNJM05sWXkxblpXNWxjbUYwYjNKeVpYTjFiV1ZjYmlBZ0lDQWdJQ0FnY21WMGRYSnVJR1J2Ym1WU1pYTjFiSFFvS1R0Y2JpQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ1kyOXVkR1Y0ZEM1dFpYUm9iMlFnUFNCdFpYUm9iMlE3WEc0Z0lDQWdJQ0JqYjI1MFpYaDBMbUZ5WnlBOUlHRnlaenRjYmx4dUlDQWdJQ0FnZDJocGJHVWdLSFJ5ZFdVcElIdGNiaUFnSUNBZ0lDQWdkbUZ5SUdSbGJHVm5ZWFJsSUQwZ1kyOXVkR1Y0ZEM1a1pXeGxaMkYwWlR0Y2JpQWdJQ0FnSUNBZ2FXWWdLR1JsYkdWbllYUmxLU0I3WEc0Z0lDQWdJQ0FnSUNBZ2RtRnlJR1JsYkdWbllYUmxVbVZ6ZFd4MElEMGdiV0Y1WW1WSmJuWnZhMlZFWld4bFoyRjBaU2hrWld4bFoyRjBaU3dnWTI5dWRHVjRkQ2s3WEc0Z0lDQWdJQ0FnSUNBZ2FXWWdLR1JsYkdWbllYUmxVbVZ6ZFd4MEtTQjdYRzRnSUNBZ0lDQWdJQ0FnSUNCcFppQW9aR1ZzWldkaGRHVlNaWE4xYkhRZ1BUMDlJRU52Ym5ScGJuVmxVMlZ1ZEdsdVpXd3BJR052Ym5ScGJuVmxPMXh1SUNBZ0lDQWdJQ0FnSUNBZ2NtVjBkWEp1SUdSbGJHVm5ZWFJsVW1WemRXeDBPMXh1SUNBZ0lDQWdJQ0FnSUgxY2JpQWdJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQWdJR2xtSUNoamIyNTBaWGgwTG0xbGRHaHZaQ0E5UFQwZ1hDSnVaWGgwWENJcElIdGNiaUFnSUNBZ0lDQWdJQ0F2THlCVFpYUjBhVzVuSUdOdmJuUmxlSFF1WDNObGJuUWdabTl5SUd4bFoyRmplU0J6ZFhCd2IzSjBJRzltSUVKaFltVnNKM05jYmlBZ0lDQWdJQ0FnSUNBdkx5Qm1kVzVqZEdsdmJpNXpaVzUwSUdsdGNHeGxiV1Z1ZEdGMGFXOXVMbHh1SUNBZ0lDQWdJQ0FnSUdOdmJuUmxlSFF1YzJWdWRDQTlJR052Ym5SbGVIUXVYM05sYm5RZ1BTQmpiMjUwWlhoMExtRnlaenRjYmx4dUlDQWdJQ0FnSUNCOUlHVnNjMlVnYVdZZ0tHTnZiblJsZUhRdWJXVjBhRzlrSUQwOVBTQmNJblJvY205M1hDSXBJSHRjYmlBZ0lDQWdJQ0FnSUNCcFppQW9jM1JoZEdVZ1BUMDlJRWRsYmxOMFlYUmxVM1Z6Y0dWdVpHVmtVM1JoY25RcElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUhOMFlYUmxJRDBnUjJWdVUzUmhkR1ZEYjIxd2JHVjBaV1E3WEc0Z0lDQWdJQ0FnSUNBZ0lDQjBhSEp2ZHlCamIyNTBaWGgwTG1GeVp6dGNiaUFnSUNBZ0lDQWdJQ0I5WEc1Y2JpQWdJQ0FnSUNBZ0lDQmpiMjUwWlhoMExtUnBjM0JoZEdOb1JYaGpaWEIwYVc5dUtHTnZiblJsZUhRdVlYSm5LVHRjYmx4dUlDQWdJQ0FnSUNCOUlHVnNjMlVnYVdZZ0tHTnZiblJsZUhRdWJXVjBhRzlrSUQwOVBTQmNJbkpsZEhWeWJsd2lLU0I3WEc0Z0lDQWdJQ0FnSUNBZ1kyOXVkR1Y0ZEM1aFluSjFjSFFvWENKeVpYUjFjbTVjSWl3Z1kyOXVkR1Y0ZEM1aGNtY3BPMXh1SUNBZ0lDQWdJQ0I5WEc1Y2JpQWdJQ0FnSUNBZ2MzUmhkR1VnUFNCSFpXNVRkR0YwWlVWNFpXTjFkR2x1Wnp0Y2JseHVJQ0FnSUNBZ0lDQjJZWElnY21WamIzSmtJRDBnZEhKNVEyRjBZMmdvYVc1dVpYSkdiaXdnYzJWc1ppd2dZMjl1ZEdWNGRDazdYRzRnSUNBZ0lDQWdJR2xtSUNoeVpXTnZjbVF1ZEhsd1pTQTlQVDBnWENKdWIzSnRZV3hjSWlrZ2UxeHVJQ0FnSUNBZ0lDQWdJQzh2SUVsbUlHRnVJR1Y0WTJWd2RHbHZiaUJwY3lCMGFISnZkMjRnWm5KdmJTQnBibTVsY2tadUxDQjNaU0JzWldGMlpTQnpkR0YwWlNBOVBUMWNiaUFnSUNBZ0lDQWdJQ0F2THlCSFpXNVRkR0YwWlVWNFpXTjFkR2x1WnlCaGJtUWdiRzl2Y0NCaVlXTnJJR1p2Y2lCaGJtOTBhR1Z5SUdsdWRtOWpZWFJwYjI0dVhHNGdJQ0FnSUNBZ0lDQWdjM1JoZEdVZ1BTQmpiMjUwWlhoMExtUnZibVZjYmlBZ0lDQWdJQ0FnSUNBZ0lEOGdSMlZ1VTNSaGRHVkRiMjF3YkdWMFpXUmNiaUFnSUNBZ0lDQWdJQ0FnSURvZ1IyVnVVM1JoZEdWVGRYTndaVzVrWldSWmFXVnNaRHRjYmx4dUlDQWdJQ0FnSUNBZ0lHbG1JQ2h5WldOdmNtUXVZWEpuSUQwOVBTQkRiMjUwYVc1MVpWTmxiblJwYm1Wc0tTQjdYRzRnSUNBZ0lDQWdJQ0FnSUNCamIyNTBhVzUxWlR0Y2JpQWdJQ0FnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnZTF4dUlDQWdJQ0FnSUNBZ0lDQWdkbUZzZFdVNklISmxZMjl5WkM1aGNtY3NYRzRnSUNBZ0lDQWdJQ0FnSUNCa2IyNWxPaUJqYjI1MFpYaDBMbVJ2Ym1WY2JpQWdJQ0FnSUNBZ0lDQjlPMXh1WEc0Z0lDQWdJQ0FnSUgwZ1pXeHpaU0JwWmlBb2NtVmpiM0prTG5SNWNHVWdQVDA5SUZ3aWRHaHliM2RjSWlrZ2UxeHVJQ0FnSUNBZ0lDQWdJSE4wWVhSbElEMGdSMlZ1VTNSaGRHVkRiMjF3YkdWMFpXUTdYRzRnSUNBZ0lDQWdJQ0FnTHk4Z1JHbHpjR0YwWTJnZ2RHaGxJR1Y0WTJWd2RHbHZiaUJpZVNCc2IyOXdhVzVuSUdKaFkyc2dZWEp2ZFc1a0lIUnZJSFJvWlZ4dUlDQWdJQ0FnSUNBZ0lDOHZJR052Ym5SbGVIUXVaR2x6Y0dGMFkyaEZlR05sY0hScGIyNG9ZMjl1ZEdWNGRDNWhjbWNwSUdOaGJHd2dZV0p2ZG1VdVhHNGdJQ0FnSUNBZ0lDQWdZMjl1ZEdWNGRDNXRaWFJvYjJRZ1BTQmNJblJvY205M1hDSTdYRzRnSUNBZ0lDQWdJQ0FnWTI5dWRHVjRkQzVoY21jZ1BTQnlaV052Y21RdVlYSm5PMXh1SUNBZ0lDQWdJQ0I5WEc0Z0lDQWdJQ0I5WEc0Z0lDQWdmVHRjYmlBZ2ZWeHVYRzRnSUM4dklFTmhiR3dnWkdWc1pXZGhkR1V1YVhSbGNtRjBiM0piWTI5dWRHVjRkQzV0WlhSb2IyUmRLR052Ym5SbGVIUXVZWEpuS1NCaGJtUWdhR0Z1Wkd4bElIUm9aVnh1SUNBdkx5QnlaWE4xYkhRc0lHVnBkR2hsY2lCaWVTQnlaWFIxY201cGJtY2dZU0I3SUhaaGJIVmxMQ0JrYjI1bElIMGdjbVZ6ZFd4MElHWnliMjBnZEdobFhHNGdJQzh2SUdSbGJHVm5ZWFJsSUdsMFpYSmhkRzl5TENCdmNpQmllU0J0YjJScFpubHBibWNnWTI5dWRHVjRkQzV0WlhSb2IyUWdZVzVrSUdOdmJuUmxlSFF1WVhKbkxGeHVJQ0F2THlCelpYUjBhVzVuSUdOdmJuUmxlSFF1WkdWc1pXZGhkR1VnZEc4Z2JuVnNiQ3dnWVc1a0lISmxkSFZ5Ym1sdVp5QjBhR1VnUTI5dWRHbHVkV1ZUWlc1MGFXNWxiQzVjYmlBZ1puVnVZM1JwYjI0Z2JXRjVZbVZKYm5admEyVkVaV3hsWjJGMFpTaGtaV3hsWjJGMFpTd2dZMjl1ZEdWNGRDa2dlMXh1SUNBZ0lIWmhjaUJ0WlhSb2IyUWdQU0JrWld4bFoyRjBaUzVwZEdWeVlYUnZjbHRqYjI1MFpYaDBMbTFsZEdodlpGMDdYRzRnSUNBZ2FXWWdLRzFsZEdodlpDQTlQVDBnZFc1a1pXWnBibVZrS1NCN1hHNGdJQ0FnSUNBdkx5QkJJQzUwYUhKdmR5QnZjaUF1Y21WMGRYSnVJSGRvWlc0Z2RHaGxJR1JsYkdWbllYUmxJR2wwWlhKaGRHOXlJR2hoY3lCdWJ5QXVkR2h5YjNkY2JpQWdJQ0FnSUM4dklHMWxkR2h2WkNCaGJIZGhlWE1nZEdWeWJXbHVZWFJsY3lCMGFHVWdlV2xsYkdRcUlHeHZiM0F1WEc0Z0lDQWdJQ0JqYjI1MFpYaDBMbVJsYkdWbllYUmxJRDBnYm5Wc2JEdGNibHh1SUNBZ0lDQWdhV1lnS0dOdmJuUmxlSFF1YldWMGFHOWtJRDA5UFNCY0luUm9jbTkzWENJcElIdGNiaUFnSUNBZ0lDQWdMeThnVG05MFpUb2dXMXdpY21WMGRYSnVYQ0pkSUcxMWMzUWdZbVVnZFhObFpDQm1iM0lnUlZNeklIQmhjbk5wYm1jZ1kyOXRjR0YwYVdKcGJHbDBlUzVjYmlBZ0lDQWdJQ0FnYVdZZ0tHUmxiR1ZuWVhSbExtbDBaWEpoZEc5eVcxd2ljbVYwZFhKdVhDSmRLU0I3WEc0Z0lDQWdJQ0FnSUNBZ0x5OGdTV1lnZEdobElHUmxiR1ZuWVhSbElHbDBaWEpoZEc5eUlHaGhjeUJoSUhKbGRIVnliaUJ0WlhSb2IyUXNJR2RwZG1VZ2FYUWdZVnh1SUNBZ0lDQWdJQ0FnSUM4dklHTm9ZVzVqWlNCMGJ5QmpiR1ZoYmlCMWNDNWNiaUFnSUNBZ0lDQWdJQ0JqYjI1MFpYaDBMbTFsZEdodlpDQTlJRndpY21WMGRYSnVYQ0k3WEc0Z0lDQWdJQ0FnSUNBZ1kyOXVkR1Y0ZEM1aGNtY2dQU0IxYm1SbFptbHVaV1E3WEc0Z0lDQWdJQ0FnSUNBZ2JXRjVZbVZKYm5admEyVkVaV3hsWjJGMFpTaGtaV3hsWjJGMFpTd2dZMjl1ZEdWNGRDazdYRzVjYmlBZ0lDQWdJQ0FnSUNCcFppQW9ZMjl1ZEdWNGRDNXRaWFJvYjJRZ1BUMDlJRndpZEdoeWIzZGNJaWtnZTF4dUlDQWdJQ0FnSUNBZ0lDQWdMeThnU1dZZ2JXRjVZbVZKYm5admEyVkVaV3hsWjJGMFpTaGpiMjUwWlhoMEtTQmphR0Z1WjJWa0lHTnZiblJsZUhRdWJXVjBhRzlrSUdaeWIyMWNiaUFnSUNBZ0lDQWdJQ0FnSUM4dklGd2ljbVYwZFhKdVhDSWdkRzhnWENKMGFISnZkMXdpTENCc1pYUWdkR2hoZENCdmRtVnljbWxrWlNCMGFHVWdWSGx3WlVWeWNtOXlJR0psYkc5M0xseHVJQ0FnSUNBZ0lDQWdJQ0FnY21WMGRYSnVJRU52Ym5ScGJuVmxVMlZ1ZEdsdVpXdzdYRzRnSUNBZ0lDQWdJQ0FnZlZ4dUlDQWdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lDQWdZMjl1ZEdWNGRDNXRaWFJvYjJRZ1BTQmNJblJvY205M1hDSTdYRzRnSUNBZ0lDQWdJR052Ym5SbGVIUXVZWEpuSUQwZ2JtVjNJRlI1Y0dWRmNuSnZjaWhjYmlBZ0lDQWdJQ0FnSUNCY0lsUm9aU0JwZEdWeVlYUnZjaUJrYjJWeklHNXZkQ0J3Y205MmFXUmxJR0VnSjNSb2NtOTNKeUJ0WlhSb2IyUmNJaWs3WEc0Z0lDQWdJQ0I5WEc1Y2JpQWdJQ0FnSUhKbGRIVnliaUJEYjI1MGFXNTFaVk5sYm5ScGJtVnNPMXh1SUNBZ0lIMWNibHh1SUNBZ0lIWmhjaUJ5WldOdmNtUWdQU0IwY25sRFlYUmphQ2h0WlhSb2IyUXNJR1JsYkdWbllYUmxMbWwwWlhKaGRHOXlMQ0JqYjI1MFpYaDBMbUZ5WnlrN1hHNWNiaUFnSUNCcFppQW9jbVZqYjNKa0xuUjVjR1VnUFQwOUlGd2lkR2h5YjNkY0lpa2dlMXh1SUNBZ0lDQWdZMjl1ZEdWNGRDNXRaWFJvYjJRZ1BTQmNJblJvY205M1hDSTdYRzRnSUNBZ0lDQmpiMjUwWlhoMExtRnlaeUE5SUhKbFkyOXlaQzVoY21jN1hHNGdJQ0FnSUNCamIyNTBaWGgwTG1SbGJHVm5ZWFJsSUQwZ2JuVnNiRHRjYmlBZ0lDQWdJSEpsZEhWeWJpQkRiMjUwYVc1MVpWTmxiblJwYm1Wc08xeHVJQ0FnSUgxY2JseHVJQ0FnSUhaaGNpQnBibVp2SUQwZ2NtVmpiM0prTG1GeVp6dGNibHh1SUNBZ0lHbG1JQ2doSUdsdVptOHBJSHRjYmlBZ0lDQWdJR052Ym5SbGVIUXViV1YwYUc5a0lEMGdYQ0owYUhKdmQxd2lPMXh1SUNBZ0lDQWdZMjl1ZEdWNGRDNWhjbWNnUFNCdVpYY2dWSGx3WlVWeWNtOXlLRndpYVhSbGNtRjBiM0lnY21WemRXeDBJR2x6SUc1dmRDQmhiaUJ2WW1wbFkzUmNJaWs3WEc0Z0lDQWdJQ0JqYjI1MFpYaDBMbVJsYkdWbllYUmxJRDBnYm5Wc2JEdGNiaUFnSUNBZ0lISmxkSFZ5YmlCRGIyNTBhVzUxWlZObGJuUnBibVZzTzF4dUlDQWdJSDFjYmx4dUlDQWdJR2xtSUNocGJtWnZMbVJ2Ym1VcElIdGNiaUFnSUNBZ0lDOHZJRUZ6YzJsbmJpQjBhR1VnY21WemRXeDBJRzltSUhSb1pTQm1hVzVwYzJobFpDQmtaV3hsWjJGMFpTQjBieUIwYUdVZ2RHVnRjRzl5WVhKNVhHNGdJQ0FnSUNBdkx5QjJZWEpwWVdKc1pTQnpjR1ZqYVdacFpXUWdZbmtnWkdWc1pXZGhkR1V1Y21WemRXeDBUbUZ0WlNBb2MyVmxJR1JsYkdWbllYUmxXV2xsYkdRcExseHVJQ0FnSUNBZ1kyOXVkR1Y0ZEZ0a1pXeGxaMkYwWlM1eVpYTjFiSFJPWVcxbFhTQTlJR2x1Wm04dWRtRnNkV1U3WEc1Y2JpQWdJQ0FnSUM4dklGSmxjM1Z0WlNCbGVHVmpkWFJwYjI0Z1lYUWdkR2hsSUdSbGMybHlaV1FnYkc5allYUnBiMjRnS0hObFpTQmtaV3hsWjJGMFpWbHBaV3hrS1M1Y2JpQWdJQ0FnSUdOdmJuUmxlSFF1Ym1WNGRDQTlJR1JsYkdWbllYUmxMbTVsZUhSTWIyTTdYRzVjYmlBZ0lDQWdJQzh2SUVsbUlHTnZiblJsZUhRdWJXVjBhRzlrSUhkaGN5QmNJblJvY205M1hDSWdZblYwSUhSb1pTQmtaV3hsWjJGMFpTQm9ZVzVrYkdWa0lIUm9aVnh1SUNBZ0lDQWdMeThnWlhoalpYQjBhVzl1TENCc1pYUWdkR2hsSUc5MWRHVnlJR2RsYm1WeVlYUnZjaUJ3Y205alpXVmtJRzV2Y20xaGJHeDVMaUJKWmx4dUlDQWdJQ0FnTHk4Z1kyOXVkR1Y0ZEM1dFpYUm9iMlFnZDJGeklGd2libVY0ZEZ3aUxDQm1iM0puWlhRZ1kyOXVkR1Y0ZEM1aGNtY2djMmx1WTJVZ2FYUWdhR0Z6SUdKbFpXNWNiaUFnSUNBZ0lDOHZJRndpWTI5dWMzVnRaV1JjSWlCaWVTQjBhR1VnWkdWc1pXZGhkR1VnYVhSbGNtRjBiM0l1SUVsbUlHTnZiblJsZUhRdWJXVjBhRzlrSUhkaGMxeHVJQ0FnSUNBZ0x5OGdYQ0p5WlhSMWNtNWNJaXdnWVd4c2IzY2dkR2hsSUc5eWFXZHBibUZzSUM1eVpYUjFjbTRnWTJGc2JDQjBieUJqYjI1MGFXNTFaU0JwYmlCMGFHVmNiaUFnSUNBZ0lDOHZJRzkxZEdWeUlHZGxibVZ5WVhSdmNpNWNiaUFnSUNBZ0lHbG1JQ2hqYjI1MFpYaDBMbTFsZEdodlpDQWhQVDBnWENKeVpYUjFjbTVjSWlrZ2UxeHVJQ0FnSUNBZ0lDQmpiMjUwWlhoMExtMWxkR2h2WkNBOUlGd2libVY0ZEZ3aU8xeHVJQ0FnSUNBZ0lDQmpiMjUwWlhoMExtRnlaeUE5SUhWdVpHVm1hVzVsWkR0Y2JpQWdJQ0FnSUgxY2JseHVJQ0FnSUgwZ1pXeHpaU0I3WEc0Z0lDQWdJQ0F2THlCU1pTMTVhV1ZzWkNCMGFHVWdjbVZ6ZFd4MElISmxkSFZ5Ym1Wa0lHSjVJSFJvWlNCa1pXeGxaMkYwWlNCdFpYUm9iMlF1WEc0Z0lDQWdJQ0J5WlhSMWNtNGdhVzVtYnp0Y2JpQWdJQ0I5WEc1Y2JpQWdJQ0F2THlCVWFHVWdaR1ZzWldkaGRHVWdhWFJsY21GMGIzSWdhWE1nWm1sdWFYTm9aV1FzSUhOdklHWnZjbWRsZENCcGRDQmhibVFnWTI5dWRHbHVkV1VnZDJsMGFGeHVJQ0FnSUM4dklIUm9aU0J2ZFhSbGNpQm5aVzVsY21GMGIzSXVYRzRnSUNBZ1kyOXVkR1Y0ZEM1a1pXeGxaMkYwWlNBOUlHNTFiR3c3WEc0Z0lDQWdjbVYwZFhKdUlFTnZiblJwYm5WbFUyVnVkR2x1Wld3N1hHNGdJSDFjYmx4dUlDQXZMeUJFWldacGJtVWdSMlZ1WlhKaGRHOXlMbkJ5YjNSdmRIbHdaUzU3Ym1WNGRDeDBhSEp2ZHl4eVpYUjFjbTU5SUdsdUlIUmxjbTF6SUc5bUlIUm9aVnh1SUNBdkx5QjFibWxtYVdWa0lDNWZhVzUyYjJ0bElHaGxiSEJsY2lCdFpYUm9iMlF1WEc0Z0lHUmxabWx1WlVsMFpYSmhkRzl5VFdWMGFHOWtjeWhIY0NrN1hHNWNiaUFnUjNCYmRHOVRkSEpwYm1kVVlXZFRlVzFpYjJ4ZElEMGdYQ0pIWlc1bGNtRjBiM0pjSWp0Y2JseHVJQ0F2THlCQklFZGxibVZ5WVhSdmNpQnphRzkxYkdRZ1lXeDNZWGx6SUhKbGRIVnliaUJwZEhObGJHWWdZWE1nZEdobElHbDBaWEpoZEc5eUlHOWlhbVZqZENCM2FHVnVJSFJvWlZ4dUlDQXZMeUJBUUdsMFpYSmhkRzl5SUdaMWJtTjBhVzl1SUdseklHTmhiR3hsWkNCdmJpQnBkQzRnVTI5dFpTQmljbTkzYzJWeWN5Y2dhVzF3YkdWdFpXNTBZWFJwYjI1eklHOW1JSFJvWlZ4dUlDQXZMeUJwZEdWeVlYUnZjaUJ3Y205MGIzUjVjR1VnWTJoaGFXNGdhVzVqYjNKeVpXTjBiSGtnYVcxd2JHVnRaVzUwSUhSb2FYTXNJR05oZFhOcGJtY2dkR2hsSUVkbGJtVnlZWFJ2Y2x4dUlDQXZMeUJ2WW1wbFkzUWdkRzhnYm05MElHSmxJSEpsZEhWeWJtVmtJR1p5YjIwZ2RHaHBjeUJqWVd4c0xpQlVhR2x6SUdWdWMzVnlaWE1nZEdoaGRDQmtiMlZ6YmlkMElHaGhjSEJsYmk1Y2JpQWdMeThnVTJWbElHaDBkSEJ6T2k4dloybDBhSFZpTG1OdmJTOW1ZV05sWW05dmF5OXlaV2RsYm1WeVlYUnZjaTlwYzNOMVpYTXZNamMwSUdadmNpQnRiM0psSUdSbGRHRnBiSE11WEc0Z0lFZHdXMmwwWlhKaGRHOXlVM2x0WW05c1hTQTlJR1oxYm1OMGFXOXVLQ2tnZTF4dUlDQWdJSEpsZEhWeWJpQjBhR2x6TzF4dUlDQjlPMXh1WEc0Z0lFZHdMblJ2VTNSeWFXNW5JRDBnWm5WdVkzUnBiMjRvS1NCN1hHNGdJQ0FnY21WMGRYSnVJRndpVzI5aWFtVmpkQ0JIWlc1bGNtRjBiM0pkWENJN1hHNGdJSDA3WEc1Y2JpQWdablZ1WTNScGIyNGdjSFZ6YUZSeWVVVnVkSEo1S0d4dlkzTXBJSHRjYmlBZ0lDQjJZWElnWlc1MGNua2dQU0I3SUhSeWVVeHZZem9nYkc5amMxc3dYU0I5TzF4dVhHNGdJQ0FnYVdZZ0tERWdhVzRnYkc5amN5a2dlMXh1SUNBZ0lDQWdaVzUwY25rdVkyRjBZMmhNYjJNZ1BTQnNiMk56V3pGZE8xeHVJQ0FnSUgxY2JseHVJQ0FnSUdsbUlDZ3lJR2x1SUd4dlkzTXBJSHRjYmlBZ0lDQWdJR1Z1ZEhKNUxtWnBibUZzYkhsTWIyTWdQU0JzYjJOeld6SmRPMXh1SUNBZ0lDQWdaVzUwY25rdVlXWjBaWEpNYjJNZ1BTQnNiMk56V3pOZE8xeHVJQ0FnSUgxY2JseHVJQ0FnSUhSb2FYTXVkSEo1Ulc1MGNtbGxjeTV3ZFhOb0tHVnVkSEo1S1R0Y2JpQWdmVnh1WEc0Z0lHWjFibU4wYVc5dUlISmxjMlYwVkhKNVJXNTBjbmtvWlc1MGNua3BJSHRjYmlBZ0lDQjJZWElnY21WamIzSmtJRDBnWlc1MGNua3VZMjl0Y0d4bGRHbHZiaUI4ZkNCN2ZUdGNiaUFnSUNCeVpXTnZjbVF1ZEhsd1pTQTlJRndpYm05eWJXRnNYQ0k3WEc0Z0lDQWdaR1ZzWlhSbElISmxZMjl5WkM1aGNtYzdYRzRnSUNBZ1pXNTBjbmt1WTI5dGNHeGxkR2x2YmlBOUlISmxZMjl5WkR0Y2JpQWdmVnh1WEc0Z0lHWjFibU4wYVc5dUlFTnZiblJsZUhRb2RISjVURzlqYzB4cGMzUXBJSHRjYmlBZ0lDQXZMeUJVYUdVZ2NtOXZkQ0JsYm5SeWVTQnZZbXBsWTNRZ0tHVm1abVZqZEdsMlpXeDVJR0VnZEhKNUlITjBZWFJsYldWdWRDQjNhWFJvYjNWMElHRWdZMkYwWTJoY2JpQWdJQ0F2THlCdmNpQmhJR1pwYm1Gc2JIa2dZbXh2WTJzcElHZHBkbVZ6SUhWeklHRWdjR3hoWTJVZ2RHOGdjM1J2Y21VZ2RtRnNkV1Z6SUhSb2NtOTNiaUJtY205dFhHNGdJQ0FnTHk4Z2JHOWpZWFJwYjI1eklIZG9aWEpsSUhSb1pYSmxJR2x6SUc1dklHVnVZMnh2YzJsdVp5QjBjbmtnYzNSaGRHVnRaVzUwTGx4dUlDQWdJSFJvYVhNdWRISjVSVzUwY21sbGN5QTlJRnQ3SUhSeWVVeHZZem9nWENKeWIyOTBYQ0lnZlYwN1hHNGdJQ0FnZEhKNVRHOWpjMHhwYzNRdVptOXlSV0ZqYUNod2RYTm9WSEo1Ulc1MGNua3NJSFJvYVhNcE8xeHVJQ0FnSUhSb2FYTXVjbVZ6WlhRb2RISjFaU2s3WEc0Z0lIMWNibHh1SUNCbGVIQnZjblJ6TG10bGVYTWdQU0JtZFc1amRHbHZiaWh2WW1wbFkzUXBJSHRjYmlBZ0lDQjJZWElnYTJWNWN5QTlJRnRkTzF4dUlDQWdJR1p2Y2lBb2RtRnlJR3RsZVNCcGJpQnZZbXBsWTNRcElIdGNiaUFnSUNBZ0lHdGxlWE11Y0hWemFDaHJaWGtwTzF4dUlDQWdJSDFjYmlBZ0lDQnJaWGx6TG5KbGRtVnljMlVvS1R0Y2JseHVJQ0FnSUM4dklGSmhkR2hsY2lCMGFHRnVJSEpsZEhWeWJtbHVaeUJoYmlCdlltcGxZM1FnZDJsMGFDQmhJRzVsZUhRZ2JXVjBhRzlrTENCM1pTQnJaV1Z3WEc0Z0lDQWdMeThnZEdocGJtZHpJSE5wYlhCc1pTQmhibVFnY21WMGRYSnVJSFJvWlNCdVpYaDBJR1oxYm1OMGFXOXVJR2wwYzJWc1ppNWNiaUFnSUNCeVpYUjFjbTRnWm5WdVkzUnBiMjRnYm1WNGRDZ3BJSHRjYmlBZ0lDQWdJSGRvYVd4bElDaHJaWGx6TG14bGJtZDBhQ2tnZTF4dUlDQWdJQ0FnSUNCMllYSWdhMlY1SUQwZ2EyVjVjeTV3YjNBb0tUdGNiaUFnSUNBZ0lDQWdhV1lnS0d0bGVTQnBiaUJ2WW1wbFkzUXBJSHRjYmlBZ0lDQWdJQ0FnSUNCdVpYaDBMblpoYkhWbElEMGdhMlY1TzF4dUlDQWdJQ0FnSUNBZ0lHNWxlSFF1Wkc5dVpTQTlJR1poYkhObE8xeHVJQ0FnSUNBZ0lDQWdJSEpsZEhWeWJpQnVaWGgwTzF4dUlDQWdJQ0FnSUNCOVhHNGdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lDOHZJRlJ2SUdGMmIybGtJR055WldGMGFXNW5JR0Z1SUdGa1pHbDBhVzl1WVd3Z2IySnFaV04wTENCM1pTQnFkWE4wSUdoaGJtY2dkR2hsSUM1MllXeDFaVnh1SUNBZ0lDQWdMeThnWVc1a0lDNWtiMjVsSUhCeWIzQmxjblJwWlhNZ2IyWm1JSFJvWlNCdVpYaDBJR1oxYm1OMGFXOXVJRzlpYW1WamRDQnBkSE5sYkdZdUlGUm9hWE5jYmlBZ0lDQWdJQzh2SUdGc2MyOGdaVzV6ZFhKbGN5QjBhR0YwSUhSb1pTQnRhVzVwWm1sbGNpQjNhV3hzSUc1dmRDQmhibTl1ZVcxcGVtVWdkR2hsSUdaMWJtTjBhVzl1TGx4dUlDQWdJQ0FnYm1WNGRDNWtiMjVsSUQwZ2RISjFaVHRjYmlBZ0lDQWdJSEpsZEhWeWJpQnVaWGgwTzF4dUlDQWdJSDA3WEc0Z0lIMDdYRzVjYmlBZ1puVnVZM1JwYjI0Z2RtRnNkV1Z6S0dsMFpYSmhZbXhsS1NCN1hHNGdJQ0FnYVdZZ0tHbDBaWEpoWW14bEtTQjdYRzRnSUNBZ0lDQjJZWElnYVhSbGNtRjBiM0pOWlhSb2IyUWdQU0JwZEdWeVlXSnNaVnRwZEdWeVlYUnZjbE41YldKdmJGMDdYRzRnSUNBZ0lDQnBaaUFvYVhSbGNtRjBiM0pOWlhSb2IyUXBJSHRjYmlBZ0lDQWdJQ0FnY21WMGRYSnVJR2wwWlhKaGRHOXlUV1YwYUc5a0xtTmhiR3dvYVhSbGNtRmliR1VwTzF4dUlDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNCcFppQW9kSGx3Wlc5bUlHbDBaWEpoWW14bExtNWxlSFFnUFQwOUlGd2lablZ1WTNScGIyNWNJaWtnZTF4dUlDQWdJQ0FnSUNCeVpYUjFjbTRnYVhSbGNtRmliR1U3WEc0Z0lDQWdJQ0I5WEc1Y2JpQWdJQ0FnSUdsbUlDZ2hhWE5PWVU0b2FYUmxjbUZpYkdVdWJHVnVaM1JvS1NrZ2UxeHVJQ0FnSUNBZ0lDQjJZWElnYVNBOUlDMHhMQ0J1WlhoMElEMGdablZ1WTNScGIyNGdibVY0ZENncElIdGNiaUFnSUNBZ0lDQWdJQ0IzYUdsc1pTQW9LeXRwSUR3Z2FYUmxjbUZpYkdVdWJHVnVaM1JvS1NCN1hHNGdJQ0FnSUNBZ0lDQWdJQ0JwWmlBb2FHRnpUM2R1TG1OaGJHd29hWFJsY21GaWJHVXNJR2twS1NCN1hHNGdJQ0FnSUNBZ0lDQWdJQ0FnSUc1bGVIUXVkbUZzZFdVZ1BTQnBkR1Z5WVdKc1pWdHBYVHRjYmlBZ0lDQWdJQ0FnSUNBZ0lDQWdibVY0ZEM1a2IyNWxJRDBnWm1Gc2MyVTdYRzRnSUNBZ0lDQWdJQ0FnSUNBZ0lISmxkSFZ5YmlCdVpYaDBPMXh1SUNBZ0lDQWdJQ0FnSUNBZ2ZWeHVJQ0FnSUNBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnSUNBZ0lHNWxlSFF1ZG1Gc2RXVWdQU0IxYm1SbFptbHVaV1E3WEc0Z0lDQWdJQ0FnSUNBZ2JtVjRkQzVrYjI1bElEMGdkSEoxWlR0Y2JseHVJQ0FnSUNBZ0lDQWdJSEpsZEhWeWJpQnVaWGgwTzF4dUlDQWdJQ0FnSUNCOU8xeHVYRzRnSUNBZ0lDQWdJSEpsZEhWeWJpQnVaWGgwTG01bGVIUWdQU0J1WlhoME8xeHVJQ0FnSUNBZ2ZWeHVJQ0FnSUgxY2JseHVJQ0FnSUM4dklGSmxkSFZ5YmlCaGJpQnBkR1Z5WVhSdmNpQjNhWFJvSUc1dklIWmhiSFZsY3k1Y2JpQWdJQ0J5WlhSMWNtNGdleUJ1WlhoME9pQmtiMjVsVW1WemRXeDBJSDA3WEc0Z0lIMWNiaUFnWlhod2IzSjBjeTUyWVd4MVpYTWdQU0IyWVd4MVpYTTdYRzVjYmlBZ1puVnVZM1JwYjI0Z1pHOXVaVkpsYzNWc2RDZ3BJSHRjYmlBZ0lDQnlaWFIxY200Z2V5QjJZV3gxWlRvZ2RXNWtaV1pwYm1Wa0xDQmtiMjVsT2lCMGNuVmxJSDA3WEc0Z0lIMWNibHh1SUNCRGIyNTBaWGgwTG5CeWIzUnZkSGx3WlNBOUlIdGNiaUFnSUNCamIyNXpkSEoxWTNSdmNqb2dRMjl1ZEdWNGRDeGNibHh1SUNBZ0lISmxjMlYwT2lCbWRXNWpkR2x2YmloemEybHdWR1Z0Y0ZKbGMyVjBLU0I3WEc0Z0lDQWdJQ0IwYUdsekxuQnlaWFlnUFNBd08xeHVJQ0FnSUNBZ2RHaHBjeTV1WlhoMElEMGdNRHRjYmlBZ0lDQWdJQzh2SUZKbGMyVjBkR2x1WnlCamIyNTBaWGgwTGw5elpXNTBJR1p2Y2lCc1pXZGhZM2tnYzNWd2NHOXlkQ0J2WmlCQ1lXSmxiQ2R6WEc0Z0lDQWdJQ0F2THlCbWRXNWpkR2x2Ymk1elpXNTBJR2x0Y0d4bGJXVnVkR0YwYVc5dUxseHVJQ0FnSUNBZ2RHaHBjeTV6Wlc1MElEMGdkR2hwY3k1ZmMyVnVkQ0E5SUhWdVpHVm1hVzVsWkR0Y2JpQWdJQ0FnSUhSb2FYTXVaRzl1WlNBOUlHWmhiSE5sTzF4dUlDQWdJQ0FnZEdocGN5NWtaV3hsWjJGMFpTQTlJRzUxYkd3N1hHNWNiaUFnSUNBZ0lIUm9hWE11YldWMGFHOWtJRDBnWENKdVpYaDBYQ0k3WEc0Z0lDQWdJQ0IwYUdsekxtRnlaeUE5SUhWdVpHVm1hVzVsWkR0Y2JseHVJQ0FnSUNBZ2RHaHBjeTUwY25sRmJuUnlhV1Z6TG1admNrVmhZMmdvY21WelpYUlVjbmxGYm5SeWVTazdYRzVjYmlBZ0lDQWdJR2xtSUNnaGMydHBjRlJsYlhCU1pYTmxkQ2tnZTF4dUlDQWdJQ0FnSUNCbWIzSWdLSFpoY2lCdVlXMWxJR2x1SUhSb2FYTXBJSHRjYmlBZ0lDQWdJQ0FnSUNBdkx5Qk9iM1FnYzNWeVpTQmhZbTkxZENCMGFHVWdiM0IwYVcxaGJDQnZjbVJsY2lCdlppQjBhR1Z6WlNCamIyNWthWFJwYjI1ek9seHVJQ0FnSUNBZ0lDQWdJR2xtSUNodVlXMWxMbU5vWVhKQmRDZ3dLU0E5UFQwZ1hDSjBYQ0lnSmlaY2JpQWdJQ0FnSUNBZ0lDQWdJQ0FnYUdGelQzZHVMbU5oYkd3b2RHaHBjeXdnYm1GdFpTa2dKaVpjYmlBZ0lDQWdJQ0FnSUNBZ0lDQWdJV2x6VG1GT0tDdHVZVzFsTG5Oc2FXTmxLREVwS1NrZ2UxeHVJQ0FnSUNBZ0lDQWdJQ0FnZEdocGMxdHVZVzFsWFNBOUlIVnVaR1ZtYVc1bFpEdGNiaUFnSUNBZ0lDQWdJQ0I5WEc0Z0lDQWdJQ0FnSUgxY2JpQWdJQ0FnSUgxY2JpQWdJQ0I5TEZ4dVhHNGdJQ0FnYzNSdmNEb2dablZ1WTNScGIyNG9LU0I3WEc0Z0lDQWdJQ0IwYUdsekxtUnZibVVnUFNCMGNuVmxPMXh1WEc0Z0lDQWdJQ0IyWVhJZ2NtOXZkRVZ1ZEhKNUlEMGdkR2hwY3k1MGNubEZiblJ5YVdWeld6QmRPMXh1SUNBZ0lDQWdkbUZ5SUhKdmIzUlNaV052Y21RZ1BTQnliMjkwUlc1MGNua3VZMjl0Y0d4bGRHbHZianRjYmlBZ0lDQWdJR2xtSUNoeWIyOTBVbVZqYjNKa0xuUjVjR1VnUFQwOUlGd2lkR2h5YjNkY0lpa2dlMXh1SUNBZ0lDQWdJQ0IwYUhKdmR5QnliMjkwVW1WamIzSmtMbUZ5Wnp0Y2JpQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ2NtVjBkWEp1SUhSb2FYTXVjblpoYkR0Y2JpQWdJQ0I5TEZ4dVhHNGdJQ0FnWkdsemNHRjBZMmhGZUdObGNIUnBiMjQ2SUdaMWJtTjBhVzl1S0dWNFkyVndkR2x2YmlrZ2UxeHVJQ0FnSUNBZ2FXWWdLSFJvYVhNdVpHOXVaU2tnZTF4dUlDQWdJQ0FnSUNCMGFISnZkeUJsZUdObGNIUnBiMjQ3WEc0Z0lDQWdJQ0I5WEc1Y2JpQWdJQ0FnSUhaaGNpQmpiMjUwWlhoMElEMGdkR2hwY3p0Y2JpQWdJQ0FnSUdaMWJtTjBhVzl1SUdoaGJtUnNaU2hzYjJNc0lHTmhkV2RvZENrZ2UxeHVJQ0FnSUNBZ0lDQnlaV052Y21RdWRIbHdaU0E5SUZ3aWRHaHliM2RjSWp0Y2JpQWdJQ0FnSUNBZ2NtVmpiM0prTG1GeVp5QTlJR1Y0WTJWd2RHbHZianRjYmlBZ0lDQWdJQ0FnWTI5dWRHVjRkQzV1WlhoMElEMGdiRzlqTzF4dVhHNGdJQ0FnSUNBZ0lHbG1JQ2hqWVhWbmFIUXBJSHRjYmlBZ0lDQWdJQ0FnSUNBdkx5QkpaaUIwYUdVZ1pHbHpjR0YwWTJobFpDQmxlR05sY0hScGIyNGdkMkZ6SUdOaGRXZG9kQ0JpZVNCaElHTmhkR05vSUdKc2IyTnJMRnh1SUNBZ0lDQWdJQ0FnSUM4dklIUm9aVzRnYkdWMElIUm9ZWFFnWTJGMFkyZ2dZbXh2WTJzZ2FHRnVaR3hsSUhSb1pTQmxlR05sY0hScGIyNGdibTl5YldGc2JIa3VYRzRnSUNBZ0lDQWdJQ0FnWTI5dWRHVjRkQzV0WlhSb2IyUWdQU0JjSW01bGVIUmNJanRjYmlBZ0lDQWdJQ0FnSUNCamIyNTBaWGgwTG1GeVp5QTlJSFZ1WkdWbWFXNWxaRHRjYmlBZ0lDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNBZ0lISmxkSFZ5YmlBaElTQmpZWFZuYUhRN1hHNGdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lHWnZjaUFvZG1GeUlHa2dQU0IwYUdsekxuUnllVVZ1ZEhKcFpYTXViR1Z1WjNSb0lDMGdNVHNnYVNBK1BTQXdPeUF0TFdrcElIdGNiaUFnSUNBZ0lDQWdkbUZ5SUdWdWRISjVJRDBnZEdocGN5NTBjbmxGYm5SeWFXVnpXMmxkTzF4dUlDQWdJQ0FnSUNCMllYSWdjbVZqYjNKa0lEMGdaVzUwY25rdVkyOXRjR3hsZEdsdmJqdGNibHh1SUNBZ0lDQWdJQ0JwWmlBb1pXNTBjbmt1ZEhKNVRHOWpJRDA5UFNCY0luSnZiM1JjSWlrZ2UxeHVJQ0FnSUNBZ0lDQWdJQzh2SUVWNFkyVndkR2x2YmlCMGFISnZkMjRnYjNWMGMybGtaU0J2WmlCaGJua2dkSEo1SUdKc2IyTnJJSFJvWVhRZ1kyOTFiR1FnYUdGdVpHeGxYRzRnSUNBZ0lDQWdJQ0FnTHk4Z2FYUXNJSE52SUhObGRDQjBhR1VnWTI5dGNHeGxkR2x2YmlCMllXeDFaU0J2WmlCMGFHVWdaVzUwYVhKbElHWjFibU4wYVc5dUlIUnZYRzRnSUNBZ0lDQWdJQ0FnTHk4Z2RHaHliM2NnZEdobElHVjRZMlZ3ZEdsdmJpNWNiaUFnSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhR0Z1Wkd4bEtGd2laVzVrWENJcE8xeHVJQ0FnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJQ0FnYVdZZ0tHVnVkSEo1TG5SeWVVeHZZeUE4UFNCMGFHbHpMbkJ5WlhZcElIdGNiaUFnSUNBZ0lDQWdJQ0IyWVhJZ2FHRnpRMkYwWTJnZ1BTQm9ZWE5QZDI0dVkyRnNiQ2hsYm5SeWVTd2dYQ0pqWVhSamFFeHZZMXdpS1R0Y2JpQWdJQ0FnSUNBZ0lDQjJZWElnYUdGelJtbHVZV3hzZVNBOUlHaGhjMDkzYmk1allXeHNLR1Z1ZEhKNUxDQmNJbVpwYm1Gc2JIbE1iMk5jSWlrN1hHNWNiaUFnSUNBZ0lDQWdJQ0JwWmlBb2FHRnpRMkYwWTJnZ0ppWWdhR0Z6Um1sdVlXeHNlU2tnZTF4dUlDQWdJQ0FnSUNBZ0lDQWdhV1lnS0hSb2FYTXVjSEpsZGlBOElHVnVkSEo1TG1OaGRHTm9URzlqS1NCN1hHNGdJQ0FnSUNBZ0lDQWdJQ0FnSUhKbGRIVnliaUJvWVc1a2JHVW9aVzUwY25rdVkyRjBZMmhNYjJNc0lIUnlkV1VwTzF4dUlDQWdJQ0FnSUNBZ0lDQWdmU0JsYkhObElHbG1JQ2gwYUdsekxuQnlaWFlnUENCbGJuUnllUzVtYVc1aGJHeDVURzlqS1NCN1hHNGdJQ0FnSUNBZ0lDQWdJQ0FnSUhKbGRIVnliaUJvWVc1a2JHVW9aVzUwY25rdVptbHVZV3hzZVV4dll5azdYRzRnSUNBZ0lDQWdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lDQWdJQ0I5SUdWc2MyVWdhV1lnS0doaGMwTmhkR05vS1NCN1hHNGdJQ0FnSUNBZ0lDQWdJQ0JwWmlBb2RHaHBjeTV3Y21WMklEd2daVzUwY25rdVkyRjBZMmhNYjJNcElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUNBZ2NtVjBkWEp1SUdoaGJtUnNaU2hsYm5SeWVTNWpZWFJqYUV4dll5d2dkSEoxWlNrN1hHNGdJQ0FnSUNBZ0lDQWdJQ0I5WEc1Y2JpQWdJQ0FnSUNBZ0lDQjlJR1ZzYzJVZ2FXWWdLR2hoYzBacGJtRnNiSGtwSUh0Y2JpQWdJQ0FnSUNBZ0lDQWdJR2xtSUNoMGFHbHpMbkJ5WlhZZ1BDQmxiblJ5ZVM1bWFXNWhiR3g1VEc5aktTQjdYRzRnSUNBZ0lDQWdJQ0FnSUNBZ0lISmxkSFZ5YmlCb1lXNWtiR1VvWlc1MGNua3VabWx1WVd4c2VVeHZZeWs3WEc0Z0lDQWdJQ0FnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJQ0FnSUNCOUlHVnNjMlVnZTF4dUlDQWdJQ0FnSUNBZ0lDQWdkR2h5YjNjZ2JtVjNJRVZ5Y205eUtGd2lkSEo1SUhOMFlYUmxiV1Z1ZENCM2FYUm9iM1YwSUdOaGRHTm9JRzl5SUdacGJtRnNiSGxjSWlrN1hHNGdJQ0FnSUNBZ0lDQWdmVnh1SUNBZ0lDQWdJQ0I5WEc0Z0lDQWdJQ0I5WEc0Z0lDQWdmU3hjYmx4dUlDQWdJR0ZpY25Wd2REb2dablZ1WTNScGIyNG9kSGx3WlN3Z1lYSm5LU0I3WEc0Z0lDQWdJQ0JtYjNJZ0tIWmhjaUJwSUQwZ2RHaHBjeTUwY25sRmJuUnlhV1Z6TG14bGJtZDBhQ0F0SURFN0lHa2dQajBnTURzZ0xTMXBLU0I3WEc0Z0lDQWdJQ0FnSUhaaGNpQmxiblJ5ZVNBOUlIUm9hWE11ZEhKNVJXNTBjbWxsYzF0cFhUdGNiaUFnSUNBZ0lDQWdhV1lnS0dWdWRISjVMblJ5ZVV4dll5QThQU0IwYUdsekxuQnlaWFlnSmlaY2JpQWdJQ0FnSUNBZ0lDQWdJR2hoYzA5M2JpNWpZV3hzS0dWdWRISjVMQ0JjSW1acGJtRnNiSGxNYjJOY0lpa2dKaVpjYmlBZ0lDQWdJQ0FnSUNBZ0lIUm9hWE11Y0hKbGRpQThJR1Z1ZEhKNUxtWnBibUZzYkhsTWIyTXBJSHRjYmlBZ0lDQWdJQ0FnSUNCMllYSWdabWx1WVd4c2VVVnVkSEo1SUQwZ1pXNTBjbms3WEc0Z0lDQWdJQ0FnSUNBZ1luSmxZV3M3WEc0Z0lDQWdJQ0FnSUgxY2JpQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ2FXWWdLR1pwYm1Gc2JIbEZiblJ5ZVNBbUpseHVJQ0FnSUNBZ0lDQWdJQ2gwZVhCbElEMDlQU0JjSW1KeVpXRnJYQ0lnZkh4Y2JpQWdJQ0FnSUNBZ0lDQWdkSGx3WlNBOVBUMGdYQ0pqYjI1MGFXNTFaVndpS1NBbUpseHVJQ0FnSUNBZ0lDQWdJR1pwYm1Gc2JIbEZiblJ5ZVM1MGNubE1iMk1nUEQwZ1lYSm5JQ1ltWEc0Z0lDQWdJQ0FnSUNBZ1lYSm5JRHc5SUdacGJtRnNiSGxGYm5SeWVTNW1hVzVoYkd4NVRHOWpLU0I3WEc0Z0lDQWdJQ0FnSUM4dklFbG5ibTl5WlNCMGFHVWdabWx1WVd4c2VTQmxiblJ5ZVNCcFppQmpiMjUwY205c0lHbHpJRzV2ZENCcWRXMXdhVzVuSUhSdklHRmNiaUFnSUNBZ0lDQWdMeThnYkc5allYUnBiMjRnYjNWMGMybGtaU0IwYUdVZ2RISjVMMk5oZEdOb0lHSnNiMk5yTGx4dUlDQWdJQ0FnSUNCbWFXNWhiR3g1Ulc1MGNua2dQU0J1ZFd4c08xeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQjJZWElnY21WamIzSmtJRDBnWm1sdVlXeHNlVVZ1ZEhKNUlEOGdabWx1WVd4c2VVVnVkSEo1TG1OdmJYQnNaWFJwYjI0Z09pQjdmVHRjYmlBZ0lDQWdJSEpsWTI5eVpDNTBlWEJsSUQwZ2RIbHdaVHRjYmlBZ0lDQWdJSEpsWTI5eVpDNWhjbWNnUFNCaGNtYzdYRzVjYmlBZ0lDQWdJR2xtSUNobWFXNWhiR3g1Ulc1MGNua3BJSHRjYmlBZ0lDQWdJQ0FnZEdocGN5NXRaWFJvYjJRZ1BTQmNJbTVsZUhSY0lqdGNiaUFnSUNBZ0lDQWdkR2hwY3k1dVpYaDBJRDBnWm1sdVlXeHNlVVZ1ZEhKNUxtWnBibUZzYkhsTWIyTTdYRzRnSUNBZ0lDQWdJSEpsZEhWeWJpQkRiMjUwYVc1MVpWTmxiblJwYm1Wc08xeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQnlaWFIxY200Z2RHaHBjeTVqYjIxd2JHVjBaU2h5WldOdmNtUXBPMXh1SUNBZ0lIMHNYRzVjYmlBZ0lDQmpiMjF3YkdWMFpUb2dablZ1WTNScGIyNG9jbVZqYjNKa0xDQmhablJsY2t4dll5a2dlMXh1SUNBZ0lDQWdhV1lnS0hKbFkyOXlaQzUwZVhCbElEMDlQU0JjSW5Sb2NtOTNYQ0lwSUh0Y2JpQWdJQ0FnSUNBZ2RHaHliM2NnY21WamIzSmtMbUZ5Wnp0Y2JpQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ2FXWWdLSEpsWTI5eVpDNTBlWEJsSUQwOVBTQmNJbUp5WldGclhDSWdmSHhjYmlBZ0lDQWdJQ0FnSUNCeVpXTnZjbVF1ZEhsd1pTQTlQVDBnWENKamIyNTBhVzUxWlZ3aUtTQjdYRzRnSUNBZ0lDQWdJSFJvYVhNdWJtVjRkQ0E5SUhKbFkyOXlaQzVoY21jN1hHNGdJQ0FnSUNCOUlHVnNjMlVnYVdZZ0tISmxZMjl5WkM1MGVYQmxJRDA5UFNCY0luSmxkSFZ5Ymx3aUtTQjdYRzRnSUNBZ0lDQWdJSFJvYVhNdWNuWmhiQ0E5SUhSb2FYTXVZWEpuSUQwZ2NtVmpiM0prTG1GeVp6dGNiaUFnSUNBZ0lDQWdkR2hwY3k1dFpYUm9iMlFnUFNCY0luSmxkSFZ5Ymx3aU8xeHVJQ0FnSUNBZ0lDQjBhR2x6TG01bGVIUWdQU0JjSW1WdVpGd2lPMXh1SUNBZ0lDQWdmU0JsYkhObElHbG1JQ2h5WldOdmNtUXVkSGx3WlNBOVBUMGdYQ0p1YjNKdFlXeGNJaUFtSmlCaFpuUmxja3h2WXlrZ2UxeHVJQ0FnSUNBZ0lDQjBhR2x6TG01bGVIUWdQU0JoWm5SbGNreHZZenRjYmlBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnY21WMGRYSnVJRU52Ym5ScGJuVmxVMlZ1ZEdsdVpXdzdYRzRnSUNBZ2ZTeGNibHh1SUNBZ0lHWnBibWx6YURvZ1puVnVZM1JwYjI0b1ptbHVZV3hzZVV4dll5a2dlMXh1SUNBZ0lDQWdabTl5SUNoMllYSWdhU0E5SUhSb2FYTXVkSEo1Ulc1MGNtbGxjeTVzWlc1bmRHZ2dMU0F4T3lCcElENDlJREE3SUMwdGFTa2dlMXh1SUNBZ0lDQWdJQ0IyWVhJZ1pXNTBjbmtnUFNCMGFHbHpMblJ5ZVVWdWRISnBaWE5iYVYwN1hHNGdJQ0FnSUNBZ0lHbG1JQ2hsYm5SeWVTNW1hVzVoYkd4NVRHOWpJRDA5UFNCbWFXNWhiR3g1VEc5aktTQjdYRzRnSUNBZ0lDQWdJQ0FnZEdocGN5NWpiMjF3YkdWMFpTaGxiblJ5ZVM1amIyMXdiR1YwYVc5dUxDQmxiblJ5ZVM1aFpuUmxja3h2WXlrN1hHNGdJQ0FnSUNBZ0lDQWdjbVZ6WlhSVWNubEZiblJ5ZVNobGJuUnllU2s3WEc0Z0lDQWdJQ0FnSUNBZ2NtVjBkWEp1SUVOdmJuUnBiblZsVTJWdWRHbHVaV3c3WEc0Z0lDQWdJQ0FnSUgxY2JpQWdJQ0FnSUgxY2JpQWdJQ0I5TEZ4dVhHNGdJQ0FnWENKallYUmphRndpT2lCbWRXNWpkR2x2YmloMGNubE1iMk1wSUh0Y2JpQWdJQ0FnSUdadmNpQW9kbUZ5SUdrZ1BTQjBhR2x6TG5SeWVVVnVkSEpwWlhNdWJHVnVaM1JvSUMwZ01Uc2dhU0ErUFNBd095QXRMV2twSUh0Y2JpQWdJQ0FnSUNBZ2RtRnlJR1Z1ZEhKNUlEMGdkR2hwY3k1MGNubEZiblJ5YVdWelcybGRPMXh1SUNBZ0lDQWdJQ0JwWmlBb1pXNTBjbmt1ZEhKNVRHOWpJRDA5UFNCMGNubE1iMk1wSUh0Y2JpQWdJQ0FnSUNBZ0lDQjJZWElnY21WamIzSmtJRDBnWlc1MGNua3VZMjl0Y0d4bGRHbHZianRjYmlBZ0lDQWdJQ0FnSUNCcFppQW9jbVZqYjNKa0xuUjVjR1VnUFQwOUlGd2lkR2h5YjNkY0lpa2dlMXh1SUNBZ0lDQWdJQ0FnSUNBZ2RtRnlJSFJvY205M2JpQTlJSEpsWTI5eVpDNWhjbWM3WEc0Z0lDQWdJQ0FnSUNBZ0lDQnlaWE5sZEZSeWVVVnVkSEo1S0dWdWRISjVLVHRjYmlBZ0lDQWdJQ0FnSUNCOVhHNGdJQ0FnSUNBZ0lDQWdjbVYwZFhKdUlIUm9jbTkzYmp0Y2JpQWdJQ0FnSUNBZ2ZWeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQXZMeUJVYUdVZ1kyOXVkR1Y0ZEM1allYUmphQ0J0WlhSb2IyUWdiWFZ6ZENCdmJteDVJR0psSUdOaGJHeGxaQ0IzYVhSb0lHRWdiRzlqWVhScGIyNWNiaUFnSUNBZ0lDOHZJR0Z5WjNWdFpXNTBJSFJvWVhRZ1kyOXljbVZ6Y0c5dVpITWdkRzhnWVNCcmJtOTNiaUJqWVhSamFDQmliRzlqYXk1Y2JpQWdJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhjSW1sc2JHVm5ZV3dnWTJGMFkyZ2dZWFIwWlcxd2RGd2lLVHRjYmlBZ0lDQjlMRnh1WEc0Z0lDQWdaR1ZzWldkaGRHVlphV1ZzWkRvZ1puVnVZM1JwYjI0b2FYUmxjbUZpYkdVc0lISmxjM1ZzZEU1aGJXVXNJRzVsZUhSTWIyTXBJSHRjYmlBZ0lDQWdJSFJvYVhNdVpHVnNaV2RoZEdVZ1BTQjdYRzRnSUNBZ0lDQWdJR2wwWlhKaGRHOXlPaUIyWVd4MVpYTW9hWFJsY21GaWJHVXBMRnh1SUNBZ0lDQWdJQ0J5WlhOMWJIUk9ZVzFsT2lCeVpYTjFiSFJPWVcxbExGeHVJQ0FnSUNBZ0lDQnVaWGgwVEc5ak9pQnVaWGgwVEc5alhHNGdJQ0FnSUNCOU8xeHVYRzRnSUNBZ0lDQnBaaUFvZEdocGN5NXRaWFJvYjJRZ1BUMDlJRndpYm1WNGRGd2lLU0I3WEc0Z0lDQWdJQ0FnSUM4dklFUmxiR2xpWlhKaGRHVnNlU0JtYjNKblpYUWdkR2hsSUd4aGMzUWdjMlZ1ZENCMllXeDFaU0J6YnlCMGFHRjBJSGRsSUdSdmJpZDBYRzRnSUNBZ0lDQWdJQzh2SUdGalkybGtaVzUwWVd4c2VTQndZWE56SUdsMElHOXVJSFJ2SUhSb1pTQmtaV3hsWjJGMFpTNWNiaUFnSUNBZ0lDQWdkR2hwY3k1aGNtY2dQU0IxYm1SbFptbHVaV1E3WEc0Z0lDQWdJQ0I5WEc1Y2JpQWdJQ0FnSUhKbGRIVnliaUJEYjI1MGFXNTFaVk5sYm5ScGJtVnNPMXh1SUNBZ0lIMWNiaUFnZlR0Y2JseHVJQ0F2THlCU1pXZGhjbVJzWlhOeklHOW1JSGRvWlhSb1pYSWdkR2hwY3lCelkzSnBjSFFnYVhNZ1pYaGxZM1YwYVc1bklHRnpJR0VnUTI5dGJXOXVTbE1nYlc5a2RXeGxYRzRnSUM4dklHOXlJRzV2ZEN3Z2NtVjBkWEp1SUhSb1pTQnlkVzUwYVcxbElHOWlhbVZqZENCemJ5QjBhR0YwSUhkbElHTmhiaUJrWldOc1lYSmxJSFJvWlNCMllYSnBZV0pzWlZ4dUlDQXZMeUJ5WldkbGJtVnlZWFJ2Y2xKMWJuUnBiV1VnYVc0Z2RHaGxJRzkxZEdWeUlITmpiM0JsTENCM2FHbGphQ0JoYkd4dmQzTWdkR2hwY3lCdGIyUjFiR1VnZEc4Z1ltVmNiaUFnTHk4Z2FXNXFaV04wWldRZ1pXRnphV3g1SUdKNUlHQmlhVzR2Y21WblpXNWxjbUYwYjNJZ0xTMXBibU5zZFdSbExYSjFiblJwYldVZ2MyTnlhWEIwTG1wellDNWNiaUFnY21WMGRYSnVJR1Y0Y0c5eWRITTdYRzVjYm4wb1hHNGdJQzh2SUVsbUlIUm9hWE1nYzJOeWFYQjBJR2x6SUdWNFpXTjFkR2x1WnlCaGN5QmhJRU52YlcxdmJrcFRJRzF2WkhWc1pTd2dkWE5sSUcxdlpIVnNaUzVsZUhCdmNuUnpYRzRnSUM4dklHRnpJSFJvWlNCeVpXZGxibVZ5WVhSdmNsSjFiblJwYldVZ2JtRnRaWE53WVdObExpQlBkR2hsY25kcGMyVWdZM0psWVhSbElHRWdibVYzSUdWdGNIUjVYRzRnSUM4dklHOWlhbVZqZEM0Z1JXbDBhR1Z5SUhkaGVTd2dkR2hsSUhKbGMzVnNkR2x1WnlCdlltcGxZM1FnZDJsc2JDQmlaU0IxYzJWa0lIUnZJR2x1YVhScFlXeHBlbVZjYmlBZ0x5OGdkR2hsSUhKbFoyVnVaWEpoZEc5eVVuVnVkR2x0WlNCMllYSnBZV0pzWlNCaGRDQjBhR1VnZEc5d0lHOW1JSFJvYVhNZ1ptbHNaUzVjYmlBZ2RIbHdaVzltSUcxdlpIVnNaU0E5UFQwZ1hDSnZZbXBsWTNSY0lpQS9JRzF2WkhWc1pTNWxlSEJ2Y25SeklEb2dlMzFjYmlrcE8xeHVYRzUwY25rZ2UxeHVJQ0J5WldkbGJtVnlZWFJ2Y2xKMWJuUnBiV1VnUFNCeWRXNTBhVzFsTzF4dWZTQmpZWFJqYUNBb1lXTmphV1JsYm5SaGJGTjBjbWxqZEUxdlpHVXBJSHRjYmlBZ0x5OGdWR2hwY3lCdGIyUjFiR1VnYzJodmRXeGtJRzV2ZENCaVpTQnlkVzV1YVc1bklHbHVJSE4wY21samRDQnRiMlJsTENCemJ5QjBhR1VnWVdKdmRtVmNiaUFnTHk4Z1lYTnphV2R1YldWdWRDQnphRzkxYkdRZ1lXeDNZWGx6SUhkdmNtc2dkVzVzWlhOeklITnZiV1YwYUdsdVp5QnBjeUJ0YVhOamIyNW1hV2QxY21Wa0xpQktkWE4wWEc0Z0lDOHZJR2x1SUdOaGMyVWdjblZ1ZEdsdFpTNXFjeUJoWTJOcFpHVnVkR0ZzYkhrZ2NuVnVjeUJwYmlCemRISnBZM1FnYlc5a1pTd2dkMlVnWTJGdUlHVnpZMkZ3WlZ4dUlDQXZMeUJ6ZEhKcFkzUWdiVzlrWlNCMWMybHVaeUJoSUdkc2IySmhiQ0JHZFc1amRHbHZiaUJqWVd4c0xpQlVhR2x6SUdOdmRXeGtJR052Ym1ObGFYWmhZbXg1SUdaaGFXeGNiaUFnTHk4Z2FXWWdZU0JEYjI1MFpXNTBJRk5sWTNWeWFYUjVJRkJ2YkdsamVTQm1iM0ppYVdSeklIVnphVzVuSUVaMWJtTjBhVzl1TENCaWRYUWdhVzRnZEdoaGRDQmpZWE5sWEc0Z0lDOHZJSFJvWlNCd2NtOXdaWElnYzI5c2RYUnBiMjRnYVhNZ2RHOGdabWw0SUhSb1pTQmhZMk5wWkdWdWRHRnNJSE4wY21samRDQnRiMlJsSUhCeWIySnNaVzB1SUVsbVhHNGdJQzh2SUhsdmRTZDJaU0J0YVhOamIyNW1hV2QxY21Wa0lIbHZkWElnWW5WdVpHeGxjaUIwYnlCbWIzSmpaU0J6ZEhKcFkzUWdiVzlrWlNCaGJtUWdZWEJ3YkdsbFpDQmhYRzRnSUM4dklFTlRVQ0IwYnlCbWIzSmlhV1FnUm5WdVkzUnBiMjRzSUdGdVpDQjViM1VuY21VZ2JtOTBJSGRwYkd4cGJtY2dkRzhnWm1sNElHVnBkR2hsY2lCdlppQjBhRzl6WlZ4dUlDQXZMeUJ3Y205aWJHVnRjeXdnY0d4bFlYTmxJR1JsZEdGcGJDQjViM1Z5SUhWdWFYRjFaU0J3Y21Wa2FXTmhiV1Z1ZENCcGJpQmhJRWRwZEVoMVlpQnBjM04xWlM1Y2JpQWdSblZ1WTNScGIyNG9YQ0p5WENJc0lGd2ljbVZuWlc1bGNtRjBiM0pTZFc1MGFXMWxJRDBnY2x3aUtTaHlkVzUwYVcxbEtUdGNibjFjYmlJc0ltTnZibk4wSUhKbFoyVnVaWEpoZEc5eVVuVnVkR2x0WlNBOUlISmxjWFZwY21Vb1hDSnlaV2RsYm1WeVlYUnZjaTF5ZFc1MGFXMWxYQ0lwTzF4eVhHNWNjbHh1WTI5dWMzUWdkRzl3YkdsdVpTQTlJR1J2WTNWdFpXNTBMbkYxWlhKNVUyVnNaV04wYjNJb1hDSXViV1Z1ZFZ3aUtUdGNjbHh1WTI5dWMzUWdiVzlpYVd4bFRXVnVkU0E5SUdSdlkzVnRaVzUwTG1kbGRFVnNaVzFsYm5SQ2VVbGtLRndpYlc5aWFXeGxUV1Z1ZFZ3aUtUdGNjbHh1WTI5dWMzUWdZMnh2YzJWQ2RHNGdQU0JrYjJOMWJXVnVkQzVuWlhSRmJHVnRaVzUwUW5sSlpDaGNJbU5zYjNObFFuUnVYQ0lwTzF4eVhHNWpiMjV6ZENCaWRYSm5aWElnUFNCa2IyTjFiV1Z1ZEM1blpYUkZiR1Z0Wlc1MFFubEpaQ2hjSW1KMWNtZGxjbHdpS1R0Y2NseHVZMjl1YzNRZ2JXOWlhV3hsVEdsemRDQTlJR1J2WTNWdFpXNTBMbWRsZEVWc1pXMWxiblJDZVVsa0tGd2liVzlpYVd4bFRHbHpkRndpS1R0Y2NseHVZMjl1YzNRZ2MyVmxUVzl5WlNBOUlHUnZZM1Z0Wlc1MExtZGxkRVZzWlcxbGJuUkNlVWxrS0Z3aWMyVmxUVzl5WlZ3aUtUdGNjbHh1WTI5dWMzUWdZV05qYjNKa1pXOXVJRDBnWkc5amRXMWxiblF1WjJWMFJXeGxiV1Z1ZEVKNVNXUW9YQ0poWTJOdmNtUmxiMjVjSWlrN1hISmNibU52Ym5OMElISmxZV1JOYjNKbE1TQTlJR1J2WTNWdFpXNTBMbWRsZEVWc1pXMWxiblJDZVVsa0tGd2ljbVZoWkUxdmNtVXhYQ0lwTzF4eVhHNWpiMjV6ZENCc2FYTjBSbWx5YzNRZ1BTQmtiMk4xYldWdWRDNW5aWFJGYkdWdFpXNTBRbmxKWkNoY0lteHBjM1JHYVhKemRGd2lLVHRjY2x4dVkyOXVjM1FnZEdWNGRFWnBjbk4wSUQwZ1pHOWpkVzFsYm5RdVoyVjBSV3hsYldWdWRFSjVTV1FvWENKMFpYaDBSbWx5YzNSY0lpazdYSEpjYm1OdmJuTjBJSFJsZUhSVFpXTnZibVFnUFNCa2IyTjFiV1Z1ZEM1blpYUkZiR1Z0Wlc1MFFubEpaQ2hjSW5SbGVIUlRaV052Ym1SY0lpazdYSEpjYm14bGRDQmpiM1Z1ZEdWeUlEMGdNenRjY2x4dWJHVjBJSEpoYVhObGNpQTlJRE03WEhKY2JtTnZibk4wSUhCeWIyUjFZM1J6SUQwZ1cxeHlYRzRnSUh0Y2NseHVJQ0FnSUhOeVl6b2dYQ0pwYldjdk1TNGdTVzVrYjI5eUxtcHdaMXdpTEZ4eVhHNGdJQ0FnYzNWaWRHbDBiR1U2SUZ3aVNXNWtiMjl5SUdWdVpYSm5lU0J6WlhKMmFXTmxjMXdpTEZ4eVhHNGdJQ0FnZEdWNGREcGNjbHh1SUNBZ0lDQWdYQ0pYWlNCb1pXeHdaV1FnU1c1a2IyOXlJR1Z1WlhKbmVTQnpaWEoyYVdObGN5QjBieUJuY21WaGRIa2djMmx0Y0d4cFpua2dkR2hsYVhJZ1kyRnpaU0J0WVc1aFoyVnRaVzUwSUhONWMzUmxiUzR1TGx3aVhISmNiaUFnZlN4Y2NseHVJQ0I3WEhKY2JpQWdJQ0J6Y21NNklGd2lhVzFuTHpJdUlFSnBjbVJwWlM1cWNHZGNJaXhjY2x4dUlDQWdJSE4xWW5ScGRHeGxPaUJjSWtKcGNtUnBaU0JIYjJ4a0lGUnZkWEp6WENJc1hISmNiaUFnSUNCMFpYaDBPbHh5WEc0Z0lDQWdJQ0JjSWxkbElHaGxiSEJsWkNCQ2FYSmtlU0JIYjJ4bUlGUnZkWEp6SUhSdklITjBZWGtnY21Wc1pYWmxZVzUwSUc5dUlHRnVJR2x1WTJ4eVpXRnphVzVuYkhrZ1kyOXRjR1YwYVhScGRtVWdiV0Z5YTJWMExpNHVYQ0pjY2x4dUlDQjlMRnh5WEc0Z0lIdGNjbHh1SUNBZ0lITnlZem9nWENKcGJXY3ZNeTRnVG05M1YyaGxjbVV1YW5CblhDSXNYSEpjYmlBZ0lDQnpkV0owYVhSc1pUb2dYQ0pPYjNkWGFHVnlaVndpTEZ4eVhHNGdJQ0FnZEdWNGREcGNjbHh1SUNBZ0lDQWdYQ0pYWlNCaWRXbHNkQ0JoSUhKbFkyOXRiV1Z1WkdGMGFXOXVjeUJoY0hBZ1ptOXlJSEJsYjNCc1pTQjNiM0pyYVc1bklHbHVJR055WldGMGFYWmxJR2x1WkhWemRISnBaWE11TGk1Y0lseHlYRzRnSUgwc1hISmNiaUFnZTF4eVhHNGdJQ0FnYzNKak9pQmNJbWx0Wnk4MExpQkdlVzVrYVhGemRtRnFjR1Z1TG1wd1oxd2lMRnh5WEc0Z0lDQWdjM1ZpZEdsMGJHVTZJRndpUm5sdVpHbHhjM1poYW5CbGJsd2lMRnh5WEc0Z0lDQWdkR1Y0ZERwY2NseHVJQ0FnSUNBZ1hDSlhaU0JqY21WaGRHVmtJR0Z1SUdGd2NDQjBhR0YwSUdobGJIQmxaQ0JqZFhOMGIyMWxjbk1nWm1sdVpDQm5hV1owY3lCaGJXOXVaeUJ0YjNKbElIUm9ZVzRnTWprd01EQXdNQ0JwZEdWdGN5NHVMbHdpWEhKY2JpQWdmU3hjY2x4dUlDQjdYSEpjYmlBZ0lDQnpjbU02SUZ3aWFXMW5MelV1SUVKNWRHaHFkV3d1YW5CblhDSXNYSEpjYmlBZ0lDQnpkV0owYVhSc1pUb2dYQ0pDZVhSb2FuVnNYQ0lzWEhKY2JpQWdJQ0IwWlhoME9seHlYRzRnSUNBZ0lDQmNJbGRsSUdOeVpXRjBaV1FnZEdseVpTQm1ZWE5vYVc5dUlHWnZjaUIwYUdVZ2FXNWpjbVZoYzJsdVoyeDVJR1ZuWVd4cGRHRnlhV0Z1SUdOaGNpQnRZV2x1ZEdsdVlXTmxJRzFoY210bGRDNHVMbHdpWEhKY2JpQWdmU3hjY2x4dUlDQjdYSEpjYmlBZ0lDQnpjbU02SUZ3aWFXMW5Mell1SUZScFkydHBiaTVxY0dkY0lpeGNjbHh1SUNBZ0lITjFZblJwZEd4bE9pQmNJbFJwWTJ0cGJsd2lMRnh5WEc0Z0lDQWdkR1Y0ZERwY2NseHVJQ0FnSUNBZ1hDSlhaU0JwYm5abGJuUmxaQ0JoSUhScGJXVWdjbVZ3YjNKMGFXNW5JSE41YzNSbGJTQm1iM0lnY0dWdmNHeGxJSGRvYnlCb1lYUmxJSFJwYldVZ2RISmhZMnRwYm1jdUxpNWNJbHh5WEc0Z0lIMHNYSEpjYmlBZ2UxeHlYRzRnSUNBZ2MzSmpPaUJjSW1sdFp5ODNMaUJWWW1WeWJXVmtjeTVxY0dkY0lpeGNjbHh1SUNBZ0lITjFZblJwZEd4bE9pQmNJbFZpWlhKdFpXUnpYQ0lzWEhKY2JpQWdJQ0IwWlhoME9seHlYRzRnSUNBZ0lDQmNJbGRsSUdOeVpXRjBaV1FnWVc0Z1lYQndJSFJvWVhRZ2FHVnNjR1ZrSUdOMWMzUnZiV1Z5Y3lCbWFXNWtJR2RwWm5SeklHRnRiMjVuSUcxdmNtVWdkR2hoYmlBeU9UQXdNREF3SUdsMFpXMXpMaTR1WENKY2NseHVJQ0I5TEZ4eVhHNGdJSHRjY2x4dUlDQWdJSE55WXpvZ1hDSnBiV2N2T0M0Z1ZzT2tjM1IwY21GbWFXc2dRMkZzWTNWc1lYUnZjaTVxY0dkY0lpeGNjbHh1SUNBZ0lITjFZblJwZEd4bE9pQmNJbGJEcEhOMGRISmhabWxySUVOaGJHTjFiR0YwYjNKY0lpeGNjbHh1SUNBZ0lIUmxlSFE2WEhKY2JpQWdJQ0FnSUZ3aVYyVWdZM0psWVhSbFpDQjBhWEpsSUdaaGMyaHBiMjRnWm05eUlIUm9aU0JwYm1OeVpXRnphVzVuYkhrZ1pXZGhiR2wwWVhKcFlXNGdZMkZ5SUcxaGFXNTBhVzVoWTJVZ2JXRnlhMlYwTGk0dVhDSmNjbHh1SUNCOUxGeHlYRzRnSUh0Y2NseHVJQ0FnSUhOeVl6b2dYQ0pwYldjdk9TNGdWSExEcEc1cGJtZHpjR0Z5ZEc1bGNpNXFjR2RjSWl4Y2NseHVJQ0FnSUhOMVluUnBkR3hsT2lCY0lsUnl3NlJ1YVc1bmMzQmhjblJ1WlhKY0lpeGNjbHh1SUNBZ0lIUmxlSFE2WEhKY2JpQWdJQ0FnSUZ3aVYyVWdhVzUyWlc1MFpXUWdZU0IwYVcxbElISmxjRzl5ZEdsdVp5QnplWE4wWlcwZ1ptOXlJSEJsYjNCc1pTQjNhRzhnYUdGMFpTQjBhVzFsSUhSeVlXTnJhVzVuTGk0dVhDSmNjbHh1SUNCOVhISmNibDA3WEhKY2JseHlYRzVrYjJOMWJXVnVkQzVoWkdSRmRtVnVkRXhwYzNSbGJtVnlLRndpYzJOeWIyeHNYQ0lzSUNncElEMCtJSHRjY2x4dUlDQnBaaUFvZDJsdVpHOTNMbkJoWjJWWlQyWm1jMlYwSUR3Z2RHOXdiR2x1WlM1amJHbGxiblJJWldsbmFIUXBJSHRjY2x4dUlDQWdJSFJ2Y0d4cGJtVXVZMnhoYzNOTWFYTjBMbkpsYlc5MlpTaGNJbVpwZUdWa1hDSXBPMXh5WEc0Z0lIMGdaV3h6WlNCN1hISmNiaUFnSUNCMGIzQnNhVzVsTG1Oc1lYTnpUR2x6ZEM1aFpHUW9YQ0ptYVhobFpGd2lLVHRjY2x4dUlDQjlYSEpjYm4wcE8xeHlYRzVjY2x4dVluVnlaMlZ5TG05dVkyeHBZMnNnUFNCbElEMCtJSHRjY2x4dUlDQmxMbkJ5WlhabGJuUkVaV1poZFd4MEtDazdYSEpjYmlBZ2JXOWlhV3hsVFdWdWRTNWpiR0Z6YzB4cGMzUXVkRzluWjJ4bEtGd2lhR2xrWlZ3aUtUdGNjbHh1ZlR0Y2NseHVYSEpjYm1Oc2IzTmxRblJ1TG05dVkyeHBZMnNnUFNCbElEMCtJSHRjY2x4dUlDQmxMbkJ5WlhabGJuUkVaV1poZFd4MEtDazdYSEpjYmlBZ2JXOWlhV3hsVFdWdWRTNWpiR0Z6YzB4cGMzUXVkRzluWjJ4bEtGd2lhR2xrWlZ3aUtUdGNjbHh1ZlR0Y2NseHVYSEpjYm0xdlltbHNaVXhwYzNRdWIyNWpiR2xqYXlBOUlDZ3BJRDArSUh0Y2NseHVJQ0J0YjJKcGJHVk5aVzUxTG1Oc1lYTnpUR2x6ZEM1MGIyZG5iR1VvWENKb2FXUmxYQ0lwTzF4eVhHNTlPMXh5WEc1Y2NseHVZV05qYjNKa1pXOXVMbUZrWkVWMlpXNTBUR2x6ZEdWdVpYSW9KMk5zYVdOckp5d2dLR1VwSUQwK0lIdGNjbHh1SUNCc1pYUWdkR0Z5WjJWMElEMGdaUzUwWVhKblpYUTdYSEpjYmlBZ1kyOXVjM1FnYkdsemRDQTlJR1J2WTNWdFpXNTBMbWRsZEVWc1pXMWxiblJ6UW5sRGJHRnpjMDVoYldVb0oyaHZkeTEzWlMxa2IxOWZkR0ZpYkdWMExXbDBaVzBuS1R0Y2NseHVJQ0JzWlhRZ1lYSnlJRDBnV3k0dUxteHBjM1JkWEhKY2JpQWdZWEp5TG0xaGNDaHBJRDArSUdrdVkyeGhjM05NYVhOMExuSmxiVzkyWlNnbmMyaHZkeWNwS1Z4eVhHNGdJSFJoY21kbGRDNWpiR0Z6YzB4cGMzUXVZV1JrS0NkemFHOTNKeWs3WEhKY2JuMHBPMXh5WEc1Y2NseHVjbVZoWkUxdmNtVXhMbTl1WTJ4cFkyc2dQU0JsSUQwK0lIdGNjbHh1SUNCbExuQnlaWFpsYm5SRVpXWmhkV3gwS0NrN1hISmNiaUFnYkdsemRFWnBjbk4wTG1Oc1lYTnpUR2x6ZEM1aFpHUW9YQ0p0YjNKbFhDSXBPMXh5WEc0Z0lIUmxlSFJHYVhKemRDNWpiR0Z6YzB4cGMzUXVZV1JrS0Z3aWJXOXlaVndpS1R0Y2NseHVmVHRjY2x4dVhISmNibkpsWVdSTmIzSmxNaTV2Ym1Oc2FXTnJJRDBnWlNBOVBpQjdYSEpjYmlBZ1pTNXdjbVYyWlc1MFJHVm1ZWFZzZENncE8xeHlYRzRnSUhSbGVIUlRaV052Ym1RdVkyeGhjM05NYVhOMExtRmtaQ2hjSW0xdmNtVmNJaWs3WEhKY2JuMDdYSEpjYmx4eVhHNWpiMjV6ZENCeVpXNWtaWEpRY205a2RXTjBjeUE5SUdsMFpXMGdQVDRnZTF4eVhHNGdJSEpsZEhWeWJpQmdQR1JwZGlCamJHRnpjejFjSW1OdmJDMHhNaUJqYjJ3dGJXUXROaUJqYjJ3dGJHY3RORndpUGx4eVhHNGdJRHhrYVhZZ1kyeGhjM005WENKd2NtOXFaV04wYzE5ZlkyRnlaRndpUGx4eVhHNGdJQ0FnUEdsdFp5QnpjbU05WENJa2UybDBaVzB1YzNKamZWd2lJR0ZzZEQxY0ltMWhjMnRjSWo1Y2NseHVJQ0FnSUR4a2FYWWdZMnhoYzNNOVhDSndjbTlxWldOMGMxOWZhVzVtYjF3aVBseHlYRzRnSUNBZ0lDQThhRFFnWTJ4aGMzTTlYQ0p3Y205cVpXTjBjMTlmYzNWaWRHbDBiR1ZjSWo0a2UybDBaVzB1YzNWaWRHbDBiR1Y5UEM5b05ENWNjbHh1SUNBZ0lDQWdQSEFnWTJ4aGMzTTlYQ0p3Y205cVpXTjBjMTlmZEdWNGRGd2lQaVI3YVhSbGJTNTBaWGgwZlR3dmNENWNjbHh1SUNBZ0lEd3ZaR2wyUGx4eVhHNGdJRHd2WkdsMlBseHlYRzQ4TDJScGRqNWdPMXh5WEc1OU8xeHlYRzVjY2x4dWJHVjBJSEpsYm1SbGNsTmxZM1JwYjI0Z1BTQndjbTlxWldOMGMwUmhkR0VnUFQ0Z2UxeHlYRzRnSUdOdmJuTjBJSEJ5YjJwbFkzUnpJRDBnY0hKdmFtVmpkSE5FWVhSaExtMWhjQ2hsYkdWdFpXNTBJRDArSUhKbGJtUmxjbEJ5YjJSMVkzUnpLR1ZzWlcxbGJuUXBLVHRjY2x4dUlDQmtiMk4xYldWdWRDNW5aWFJGYkdWdFpXNTBRbmxKWkNoY0luQnliMnBsWTNSelVtVnVaR1Z5WENJcExtbHVibVZ5U0ZSTlRDQTlJSEJ5YjJwbFkzUnpMbXB2YVc0b1hDSmNJaWs3WEhKY2JuMDdYSEpjYmx4eVhHNXpaV1ZOYjNKbExtOXVZMnhwWTJzZ1BTQmxJRDArSUh0Y2NseHVJQ0JsTG5CeVpYWmxiblJFWldaaGRXeDBLQ2s3WEhKY2JpQWdZMjkxYm5SbGNpQXJQU0J5WVdselpYSTdYSEpjYmlBZ2NtVnVaR1Z5VTJWamRHbHZiaWh3Y205a2RXTjBjeTV6YkdsalpTZ3dMQ0JqYjNWdWRHVnlLU2s3WEhKY2JuMDdYSEpjYmx4eVhHNTNhVzVrYjNjdVlXUmtSWFpsYm5STWFYTjBaVzVsY2loY0lrUlBUVU52Ym5SbGJuUk1iMkZrWldSY0lpd2dLQ2tnUFQ0Z2UxeHlYRzRnSUdOdmJuTjBJSGRwZEdSb1EyOTFiblJsY2lBOUlHRnplVzVqSUNncElEMCtJSHRjY2x4dUlDQWdJSE4zYVhSamFDQW9kSEoxWlNrZ2UxeHlYRzRnSUNBZ0lDQmpZWE5sSUdSdlkzVnRaVzUwTG1SdlkzVnRaVzUwUld4bGJXVnVkQzVqYkdsbGJuUlhhV1IwYUNBK0lEYzJPRHBjY2x4dUlDQWdJQ0FnSUNCamIzVnVkR1Z5SUQwZ09UdGNjbHh1SUNBZ0lDQWdJQ0JpY21WaGF6dGNjbHh1SUNBZ0lDQWdZMkZ6WlNCa2IyTjFiV1Z1ZEM1a2IyTjFiV1Z1ZEVWc1pXMWxiblF1WTJ4cFpXNTBWMmxrZEdnZ1BpQTBNVFE2WEhKY2JpQWdJQ0FnSUNBZ1kyOTFiblJsY2lBOUlEUTdYSEpjYmlBZ0lDQWdJQ0FnY21GcGMyVnlJRDBnTkR0Y2NseHVJQ0FnSUNBZ0lDQmljbVZoYXp0Y2NseHVJQ0FnSUNBZ1pHVm1ZWFZzZERwY2NseHVJQ0FnSUNBZ0lDQmpiM1Z1ZEdWeUlEMGdNenRjY2x4dUlDQWdJQ0FnSUNCeVlXbHpaWElnUFNBek8xeHlYRzRnSUNBZ0lDQWdJR0p5WldGck8xeHlYRzRnSUNBZ2ZWeHlYRzRnSUgwN1hISmNiaUFnZDJsMFpHaERiM1Z1ZEdWeUtDazdYSEpjYmlBZ2NtVnVaR1Z5VTJWamRHbHZiaWh3Y205a2RXTjBjeTV6YkdsalpTZ3dMQ0JqYjNWdWRHVnlLU2s3WEhKY2JuMHBPMXh5WEc0aVhYMD0ifQ==
